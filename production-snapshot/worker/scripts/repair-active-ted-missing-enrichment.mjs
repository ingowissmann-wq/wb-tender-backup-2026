import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import {createFixedScopedPool,loadBackgroundScope} from "../platform/scoped-pg-pool.mjs";
import {loadNotice,persistEnrichment,PIPELINE_VERSION} from "../platform/autopilot-pipeline-worker.mjs";

const apply=process.argv.includes("--apply"),summary=process.argv.includes("--summary"),expected=process.argv.find(x=>x.startsWith("--expected-plan-sha256="))?.split("=")[1]||"";
const limit=Math.max(1,Math.min(500,Number(process.argv.find(x=>x.startsWith("--limit="))?.split("=")[1]||500)));
const stable=value=>Array.isArray(value)?`[${value.map(stable).join(",")}]`:value&&typeof value==="object"?`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`:JSON.stringify(value);
const hash=value=>crypto.createHash("sha256").update(stable(value)).digest("hex");
const connectionString=process.env.DATABASE_URL||fs.readFileSync(process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8").trim();
const rawPool=new pg.Pool({connectionString,max:4,options:[!apply?"-c default_transaction_read_only=on":"","-c statement_timeout=120000",process.env.DATABASE_SESSION_OPTIONS].filter(Boolean).join(" ")});
const pool=createFixedScopedPool(rawPool,await loadBackgroundScope(rawPool)).pool;
const safety=(await pool.query("SELECT external_submission_enabled,allow_external_submission,global_kill_switch FROM tender.submission_runtime_settings")).rows[0];
if(safety?.external_submission_enabled||safety?.allow_external_submission||safety?.global_kill_switch!==true)throw new Error("submission_safety_not_locked");
const candidates=(await pool.query(`SELECT tender.id tender_id,tender.external_id,tender.source_code,tender.source_url,
    count(context.id)::int context_count,array_agg(context.id ORDER BY context.id) context_ids
  FROM tender.tenders tender JOIN tender.pipeline_contexts context ON context.tender_id=tender.id
  WHERE tender.data_class='PUBLIC_REAL' AND tender.source_lifecycle_status='ACTIVE'
    AND tender.participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE') AND tender.offer_deadline>now()
    AND tender.source_code='TED' AND tender.external_id~'^[0-9]+-[0-9]{4}$'
    AND tender.source_url~'^https://([a-z0-9-]+\\.)*ted\\.europa\\.eu/'
    AND context.context_integrity_status='REPAIR_REQUIRED' AND context.lot_key=''
    AND context.lot_id IS NULL AND context.enrichment_version_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM tender.enrichment_versions enrichment
      WHERE enrichment.tender_id=tender.id AND enrichment.historical=false)
  GROUP BY tender.id,tender.external_id,tender.source_code,tender.source_url
  ORDER BY tender.offer_deadline,tender.id LIMIT $1`,[limit])).rows;
const plan={schemaVersion:1,repair:"ACTIVE_TED_CURRENT_ENRICHMENT_FROM_OFFICIAL_XML",pipelineVersion:PIPELINE_VERSION,
  candidates:candidates.map(x=>({tenderId:x.tender_id,externalId:x.external_id,sourceCode:x.source_code,
    sourceUrl:x.source_url,contextCount:x.context_count,contextIds:x.context_ids})),
  totalTenders:candidates.length,totalContexts:candidates.reduce((n,x)=>n+x.context_count,0),
  externalWrite:false,externalSubmission:false,transmitted:false};
const planSha256=hash(plan);
if(!apply){console.log(JSON.stringify({mode:"READ_ONLY_PLAN",planSha256,plan:summary?{schemaVersion:plan.schemaVersion,repair:plan.repair,pipelineVersion:plan.pipelineVersion,totalTenders:plan.totalTenders,totalContexts:plan.totalContexts,externalWrite:false,externalSubmission:false,transmitted:false}:plan,safety,requiredApplyArgument:`--expected-plan-sha256=${planSha256}`},null,2));await rawPool.end();process.exit(0)}
if(expected!==planSha256)throw new Error("active_ted_enrichment_plan_hash_mismatch");
const run=(await pool.query("INSERT INTO tender.enrichment_runs(kind,status,mapper_version,parser_version,metadata) VALUES('AUTHORITATIVE_ACTIVE_TED_CONTEXT_REPAIR','RUNNING',$1,$1,$2::jsonb) RETURNING id",[PIPELINE_VERSION,JSON.stringify({planSha256,totalTenders:plan.totalTenders,totalContexts:plan.totalContexts,externalWrite:false,externalSubmission:false,transmitted:false})])).rows[0];
const results=[];
for(const item of candidates){
  try{
    const current=(await pool.query(`SELECT tender.* FROM tender.tenders tender WHERE tender.id=$1
      AND tender.source_code='TED' AND tender.source_lifecycle_status='ACTIVE' AND tender.offer_deadline>now()
      AND NOT EXISTS(SELECT 1 FROM tender.enrichment_versions enrichment WHERE enrichment.tender_id=tender.id AND enrichment.historical=false)`,[item.tender_id])).rows[0];
    if(!current)throw new Error("candidate_changed_before_apply");
    const parsed=await loadNotice(pool,current),enrichment=await persistEnrichment(pool,run.id,current,parsed);
    const updated=(await pool.query(`UPDATE tender.pipeline_contexts context SET enrichment_version_id=$2,lot_id=NULL
      WHERE context.id=ANY($1::uuid[]) AND context.tender_id=$3 AND context.lot_key=''
        AND context.context_integrity_status='REPAIR_REQUIRED' AND context.lot_id IS NULL
        AND context.enrichment_version_id IS NULL RETURNING id,context_integrity_status`,[item.context_ids,enrichment.id,item.tender_id])).rows;
    if(updated.length!==item.context_count||updated.some(x=>x.context_integrity_status!=="TENDER_GLOBAL"))throw new Error("tender_global_context_transition_failed");
    await pool.query("INSERT INTO tender.audit_events(action,tender_id,metadata) VALUES('ACTIVE_TED_MISSING_ENRICHMENT_REPAIRED',$1,$2::jsonb)",[item.tender_id,JSON.stringify({planSha256,enrichmentVersionId:enrichment.id,externalId:item.external_id,contextIds:item.context_ids,contextCount:updated.length,sourceHost:"ted.europa.eu",sourcePayloadSha256:parsed.payloadSha256,externalWrite:false,externalSubmission:false,transmitted:false})]);
    results.push({tenderId:item.tender_id,externalId:item.external_id,status:"REPAIRED",enrichmentVersionId:enrichment.id,contexts:updated.length});
  }catch(error){results.push({tenderId:item.tender_id,externalId:item.external_id,status:"FAILED",safeError:String(error.message).slice(0,160),contexts:0})}
}
const repaired=results.filter(x=>x.status==="REPAIRED").length,failed=results.length-repaired,contexts=results.reduce((n,x)=>n+x.contexts,0);
await pool.query("UPDATE tender.enrichment_runs SET status=$2,finished_at=now(),total=$3,enriched=$4,metadata=metadata||$5::jsonb WHERE id=$1",[run.id,failed?"SUCCESS_WITH_WARNINGS":"SUCCESS",results.length,repaired,JSON.stringify({repaired,failed,contexts,externalWrite:false,externalSubmission:false,transmitted:false})]);
console.log(JSON.stringify({mode:"APPLIED",planSha256,runId:run.id,repaired,failed,contexts,results,safety,externalWrite:false,externalSubmission:false,transmitted:false},null,2));
await rawPool.end();
