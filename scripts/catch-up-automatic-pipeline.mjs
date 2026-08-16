import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";
import {classifyNoticeType,jobIdempotencyKey,PIPELINE_SCHEMA_VERSION} from "../platform/canonical-truth.mjs";

const apply=process.env.APPLY_BACKFILL==="true";
const forceProfileReprocess=process.env.FORCE_PROFILE_REPROCESS==="true";
const connectionString=process.env.DATABASE_URL||fs.readFileSync(process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8").trim();
const pool=new pg.Pool({connectionString,max:2});
const summary={dryRun:!apply,checked:0,queued:0,skipped:0,awardNotices:0,candidates:[]};
try{
  const locked=(await pool.query("SELECT pg_try_advisory_lock(hashtext('wb-tender-automatic-catchup-v1')) locked")).rows[0].locked;
  if(!locked){console.log(JSON.stringify({...summary,skippedBecauseLocked:true,externalTransmission:false}));process.exitCode=0}
  if(!locked)throw Object.assign(new Error("catchup_lock_held"),{handled:true});
  const candidates=(await pool.query(`SELECT r.tender_id,r.lot_key,r.company_id,r.service_line,r.evaluation_version,
    tv.id tender_version_id,ev.id enrichment_version_id,ev.version document_revision,
    ps.id profile_snapshot_id,ps.snapshot_sha256 profile_revision,
    coalesce(cc.version,0) calculation_version,
    coalesce(ev.notice_type,'UNKNOWN_NOTICE') notice_type,ev.structured_data,
    q.status last_job_status,q.calculation_status,m.id management_output_id,m.management_output_version
   FROM tender.current_service_relevance r
   JOIN LATERAL(SELECT id FROM tender.tender_versions WHERE tender_id=r.tender_id ORDER BY version DESC LIMIT 1) tv ON true
   LEFT JOIN LATERAL(SELECT id,version,notice_type,structured_data FROM tender.enrichment_versions WHERE tender_id=r.tender_id ORDER BY version DESC LIMIT 1) ev ON true
   LEFT JOIN LATERAL(SELECT id,snapshot_sha256 FROM tender.effective_profile_snapshots WHERE company_id=r.company_id AND service_line=r.service_line ORDER BY created_at DESC LIMIT 1) ps ON true
   LEFT JOIN LATERAL(SELECT version FROM tender.cost_configurations WHERE company_id=r.company_id AND service_line=r.service_line AND status='ACTIVE' ORDER BY version DESC LIMIT 1) cc ON true
   LEFT JOIN LATERAL(SELECT status,calculation_status FROM tender.autopilot_queue WHERE tender_id=r.tender_id AND company_id=r.company_id AND lot_key IS NOT DISTINCT FROM r.lot_key AND action_type='RUN_FULL_PIPELINE' ORDER BY created_at DESC LIMIT 1) q ON true
   LEFT JOIN tender.management_outputs m ON m.tender_id=r.tender_id AND m.company_id=r.company_id AND m.lot_key=coalesce(r.lot_key,'') AND m.historical=false
   WHERE r.relevance_status='RELEVANT' AND r.service_scope_gate='PASSED' AND r.primary_company=true AND r.recommendation='FULL_PIPELINE_ALLOWED' AND r.service_line IN ('cleaning','security')
   ORDER BY r.tender_id,r.lot_key,r.company_id`)).rows;
  summary.checked=candidates.length;
  for(const row of candidates){
    const noticeType=row.notice_type==="UNKNOWN_NOTICE"?classifyNoticeType(row.structured_data):row.notice_type;
    if(noticeType==="AWARD_NOTICE"){summary.awardNotices++;summary.skipped++;if(apply)await pool.query("UPDATE tender.enrichment_versions SET notice_type='AWARD_NOTICE',historical=true WHERE id=$1",[row.enrichment_version_id]);continue}
    const complete=row.calculation_status==="CALCULATED"&&row.management_output_id&&Number(row.management_output_version)>=2;
    const running=["PENDING","QUEUED","CLAIMED","RUNNING","RETRY"].includes(row.last_job_status);
    if((complete&&!forceProfileReprocess)||running||!row.profile_snapshot_id){summary.skipped++;continue}
    const reprocessRevision=forceProfileReprocess?"effective-profile-documents-v4":"management-v2";
    const key=jobIdempotencyKey({tenderId:row.tender_id,lotKey:row.lot_key,companyId:row.company_id,profileSnapshotId:row.profile_revision,documentRevision:row.document_revision,calculationVersion:`${row.calculation_version}:${reprocessRevision}`,pipelineVersion:PIPELINE_SCHEMA_VERSION,step:"RUN_FULL_PIPELINE"});
    summary.candidates.push({tenderId:row.tender_id,lotKey:row.lot_key,companyId:row.company_id,reason:row.last_job_status?"STALE_OR_INCOMPLETE":"NOT_STARTED",idempotencyKey:key});
    if(!apply)continue;
    const requestId=crypto.randomUUID(),reason=`AUTOMATIC_CATCHUP_${forceProfileReprocess?"EFFECTIVE_PROFILE_DOCUMENTS_V4":"MGMT_V2"}_${row.lot_key||"TENDER"}_${row.company_id}_${row.profile_revision}_${row.document_revision}`;
    const inserted=(await pool.query(`INSERT INTO tender.autopilot_queue(request_id,action_type,tender_id,tender_version_id,company_id,service_scope,enrichment_version_id,assessment_version_id,idempotency_key,reason,status,current_step,lot_key,calculation_status,next_step) VALUES($1,'RUN_FULL_PIPELINE',$2,$3,$4,$5,$6,$7,$8,$9,'QUEUED','QUEUED',$10,'CALCULATION_QUEUED','FETCH_DOCUMENTS') ON CONFLICT DO NOTHING RETURNING id`,[requestId,row.tender_id,row.tender_version_id,row.company_id,row.service_line,row.enrichment_version_id,row.evaluation_version,key,reason,row.lot_key])).rows[0];
    if(inserted)summary.queued++;else summary.skipped++;
  }
  const run=(await pool.query("INSERT INTO tender.pipeline_catchup_runs(dry_run,checked,queued,skipped,details,finished_at) VALUES($1,$2,$3,$4,$5::jsonb,now()) RETURNING id",[!apply,summary.checked,summary.queued,summary.skipped,JSON.stringify({awardNotices:summary.awardNotices,candidateCount:summary.candidates.length})])).rows[0];
  console.log(JSON.stringify({...summary,candidates:summary.candidates.slice(0,20),candidateCount:summary.candidates.length,runId:run.id,externalTransmission:false}));
}catch(error){if(!error.handled)throw error}finally{await pool.query("SELECT pg_advisory_unlock(hashtext('wb-tender-automatic-catchup-v1'))").catch(()=>{});await pool.end()}
