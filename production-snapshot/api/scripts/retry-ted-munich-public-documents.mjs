import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import {createFixedScopedPool,loadBackgroundScope} from "../platform/scoped-pg-pool.mjs";

const apply=process.argv.includes("--apply"),expected=process.argv.find(value=>value.startsWith("--expected-plan-sha256="))?.split("=")[1]||"",
  requestedExternalId=process.argv.find(value=>value.startsWith("--external-id="))?.split("=")[1]||"";
const allowedExternalIds=new Set(["540350-2026","552392-2026"]);
if(requestedExternalId&&!allowedExternalIds.has(requestedExternalId))throw new Error("public_document_retry_target_not_allowed");
const stable=value=>Array.isArray(value)?`[${value.map(stable).join(",")}]`:value&&typeof value==="object"?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`:JSON.stringify(value);
const hash=value=>crypto.createHash("sha256").update(stable(value)).digest("hex");
const connectionString=process.env.DATABASE_URL||fs.readFileSync(process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8").trim();
const rawPool=new pg.Pool({connectionString,max:1,options:[!apply?"-c default_transaction_read_only=on":"","-c statement_timeout=30000",process.env.DATABASE_SESSION_OPTIONS].filter(Boolean).join(" ")});
const pool=createFixedScopedPool(rawPool,await loadBackgroundScope(rawPool)).pool;
const safety=(await pool.query("SELECT external_submission_enabled,allow_external_submission,global_kill_switch FROM tender.submission_runtime_settings")).rows[0];
if(safety?.external_submission_enabled||safety?.allow_external_submission||safety?.global_kill_switch!==true)throw new Error("submission_safety_not_locked");
const jobs=(await pool.query(`SELECT job.id,job.tender_id,tender.external_id,job.company_id,job.lot_id,job.lot_key,
    job.portal_id,job.credential_id,job.enrichment_version_id,job.status,job.current_step,job.attempt,
    job.documents_found,job.documents_downloaded,job.error_code,job.error_detail_safe
  FROM tender.autopilot_queue job JOIN tender.tenders tender ON tender.id=job.tender_id
  WHERE tender.external_id IN('540350-2026','552392-2026') AND job.action_type='FETCH_DOCUMENTS'
    AND job.reason='AUTHORITATIVE_PUBLIC_MUNICH_DOCUMENT_DOWNLOAD'
    AND job.portal_id='71c824fd-1775-47f8-ae48-2d1c73b5e851' AND job.credential_id IS NULL
    AND job.lot_key='LOT-0000' ORDER BY tender.external_id,job.created_at DESC`)).rows;
const unique=[...new Map(jobs.map(job=>[job.external_id,job])).values()];
const selected=requestedExternalId?unique.filter(job=>job.external_id===requestedExternalId):unique.filter(job=>Number(job.documents_downloaded)===0);
if(!selected.length||selected.some(job=>Number(job.documents_downloaded)!==0||!['SUCCEEDED','RETRY','FAILED','CANCELLED','DEAD_LETTER'].includes(job.status)))throw new Error("public_document_retry_precondition_failed");
const plan={schemaVersion:2,reason:"PUBLIC_DOCUMENT_SCOPE_AND_AUTHORITATIVE_SELECTION_REPAIRED_131_22",jobs:selected.map(job=>({
  jobId:job.id,tenderId:job.tender_id,externalId:job.external_id,companyId:job.company_id,lotId:job.lot_id,
  lotKey:job.lot_key,portalId:job.portal_id,enrichmentVersionId:job.enrichment_version_id,priorStatus:job.status,
  priorErrorCode:job.error_code,priorSafeError:job.error_detail_safe,
})),externalWrite:false,externalSubmission:false,transmitted:false};
const planSha256=hash(plan);
if(!apply){console.log(JSON.stringify({mode:"READ_ONLY_PLAN",planSha256,plan,safety,requiredApplyArgument:`--expected-plan-sha256=${planSha256}`},null,2));await rawPool.end();process.exit(0)}
if(expected!==planSha256)throw new Error("public_document_retry_plan_hash_mismatch");
const client=await pool.connect();let updated=0;
try{
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ted-munich-public-document-retry',0))");
  for(const job of selected){const result=await client.query(`UPDATE tender.autopilot_queue SET status='QUEUED',attempt=0,
      next_attempt_at=now(),claimed_at=NULL,finished_at=NULL,started_at=NULL,heartbeat_at=NULL,worker_id=NULL,
      current_step='QUEUED',progress_percent=0,error_code=NULL,safe_error_code=NULL,error_detail_safe=NULL,
      blocking_reason=NULL,terminal_result=NULL,result_summary=NULL,document_resolution_status=NULL,documents_found=0,documents_downloaded=0,
      documents_analyzed=0,total_items=0,successful_items=0,failed_items=0,next_step='FETCH_DOCUMENTS'
    WHERE id=$1 AND status=$2 AND coalesce(documents_downloaded,0)=0`,[job.id,job.status]);updated+=result.rowCount}
  if(updated!==selected.length)throw new Error("public_document_retry_concurrent_change");
  await client.query("INSERT INTO tender.audit_events(action,metadata) VALUES('TED_MUNICH_PUBLIC_DOCUMENT_JOBS_RETRIED',$1::jsonb)",
    [JSON.stringify({planSha256,updated,reason:plan.reason,externalWrite:false,externalSubmission:false,transmitted:false})]);
  await client.query("COMMIT");
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{client.release();await rawPool.end()}
console.log(JSON.stringify({mode:"APPLIED",planSha256,updated,externalWrite:false,externalSubmission:false,transmitted:false},null,2));
