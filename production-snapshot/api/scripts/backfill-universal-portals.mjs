import {readFileSync} from "node:fs";
import crypto from "node:crypto";
import pg from "pg";

const connectionString=process.env.DATABASE_URL||readFileSync(process.env.DATABASE_URL_FILE,"utf8").trim();
const batchSize=Math.min(25,Math.max(1,Number(process.env.BACKFILL_BATCH_SIZE||10)));
const runKey=process.env.BACKFILL_RUN_KEY||"universal-portal-v1-20260804";
const dryRun=process.env.BACKFILL_DRY_RUN==="true";
const pool=new pg.Pool({connectionString,max:2});

const candidatesSql=`WITH latest_enrichment AS(
 SELECT DISTINCT ON(tender_id) id,tender_id,version FROM tender.enrichment_versions ORDER BY tender_id,version DESC
), problem AS(
 SELECT DISTINCT le.tender_id FROM latest_enrichment le JOIN tender.enrichment_documents d ON d.enrichment_version_id=le.id
 WHERE d.fetch_status IN('LOGIN_REDIRECT_UNERWARTET','DOKUMENT_NICHT_ÖFFENTLICH_ZUGÄNGLICH','DOWNLOAD_FEHLGESCHLAGEN','PORTALZUGANG_ERFORDERLICH','DOKUMENT_NOCH_NICHT_ABGERUFEN','DOKUMENTENLISTE_NICHT_GEFUNDEN','KEINE_DOKUMENTE_ERMITTELT','TECHNISCHER_CONNECTORFEHLER','SESSION_ABGELAUFEN','KALKULATION_NOCH_NICHT_MÖGLICH')
    OR coalesce(d.resolution_status,'') IN('DOWNLOAD_FAILED','PORTAL_ACCESS_REQUIRED')
 UNION SELECT DISTINCT tender_id FROM tender.autopilot_queue WHERE error_code IN('WORKER_NICHT_VERFUEGBAR','LOGIN_REDIRECT_UNERWARTET','TECHNISCHER_CONNECTORFEHLER','SESSION_ABGELAUFEN')
 UNION SELECT DISTINCT tender_id FROM tender.autopilot_queue WHERE status='SUCCEEDED' AND action_type='TEST_DOCUMENT_FETCH' AND successful_items=0 AND skipped_items=0 AND failed_items=0
 UNION SELECT DISTINCT tender_id FROM tender.current_service_relevance WHERE recommendation='FULL_PIPELINE_ALLOWED'
)
SELECT r.tender_id,r.company_id,r.lot_key,r.service_line,r.evaluation_version assessment_version,t.notice_number,t.external_id,tv.id tender_version_id,le.id enrichment_version_id,l.id lot_id,
 (SELECT p.id FROM tender.enrichment_documents d JOIN tender.portal_registry p ON lower(split_part(split_part(d.source_url,'://',2),'/',1))=p.canonical_domain OR lower(split_part(split_part(d.source_url,'://',2),'/',1))=ANY(p.allowed_subdomains) WHERE d.enrichment_version_id=le.id ORDER BY p.adapter_enabled DESC,p.id LIMIT 1) portal_id
FROM tender.current_service_relevance r JOIN problem x ON x.tender_id=r.tender_id JOIN tender.tenders t ON t.id=r.tender_id
JOIN LATERAL(SELECT id FROM tender.tender_versions WHERE tender_id=t.id ORDER BY version DESC LIMIT 1)tv ON true
JOIN latest_enrichment le ON le.tender_id=t.id
LEFT JOIN tender.lots l ON l.tender_id=t.id AND l.external_id=r.lot_key
WHERE r.relevance_status='RELEVANT' AND r.service_scope_gate='PASSED' AND r.recommendation='FULL_PIPELINE_ALLOWED' AND r.primary_company
ORDER BY r.tender_id,r.company_id,r.lot_key NULLS FIRST`;

async function queue(candidate){
  const configurationVersion=String((await pool.query("SELECT max(configuration_version_no) v FROM tender.region_evaluations WHERE tender_id=$1 AND company_id=$2",[candidate.tender_id,candidate.company_id])).rows[0]?.v??"UNVERSIONED");
  const credential=candidate.portal_id?(await pool.query("SELECT c.id FROM tender.portal_credential_secrets c JOIN tender.portal_credential_companies pc ON pc.credential_id=c.id WHERE c.portal_id=$1 AND c.status='ACTIVE' AND pc.company_id=$2 ORDER BY c.version DESC LIMIT 1",[candidate.portal_id,candidate.company_id])).rows[0]:null;
  const portal=candidate.portal_id?(await pool.query("SELECT adapter_id,adapter_version FROM tender.portal_registry WHERE id=$1",[candidate.portal_id])).rows[0]:null;
  const key=[runKey,candidate.tender_id,candidate.tender_version_id,candidate.lot_key||"-",candidate.company_id,candidate.enrichment_version_id,candidate.assessment_version,configurationVersion].join(":");
  const already=(await pool.query("SELECT id,status FROM tender.autopilot_queue WHERE idempotency_key=$1 OR (action_type='RUN_FULL_PIPELINE' AND tender_id=$2 AND company_id=$3 AND lot_key IS NOT DISTINCT FROM $4 AND created_at>=(SELECT started_at FROM tender.portal_backfill_checkpoints WHERE run_key=$5) AND status IN('QUEUED','RUNNING','RETRY','SUCCEEDED')) ORDER BY created_at DESC LIMIT 1",[key,candidate.tender_id,candidate.company_id,candidate.lot_key,runKey])).rows[0];
  if(already)return {queued:false,reason:`existing_${already.status}`,id:already.id};
  if(dryRun)return {queued:false,reason:"dry_run"};
  const row=(await pool.query(`INSERT INTO tender.autopilot_queue(request_id,action_type,tender_id,tender_version_id,notice_id,lot_id,lot_key,company_id,service_scope,portal_id,credential_id,enrichment_version_id,assessment_version_id,configuration_version_id,adapter_id,adapter_version,idempotency_key,reason,status,current_step,calculation_status,next_step)
   VALUES($1,'RUN_FULL_PIPELINE',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'QUEUED','QUEUED','DOCUMENT_FETCH_QUEUED','FETCH_DOCUMENTS') RETURNING id`,[crypto.randomUUID(),candidate.tender_id,candidate.tender_version_id,candidate.notice_number||candidate.external_id,candidate.lot_id,candidate.lot_key,candidate.company_id,candidate.service_line,candidate.portal_id,credential?.id||null,candidate.enrichment_version_id,candidate.assessment_version,configurationVersion,portal?.adapter_id||null,portal?.adapter_version||null,key,`UNIVERSAL_PORTAL_BACKFILL_${runKey}_${candidate.company_id}_${candidate.lot_key||"ALL"}`])).rows[0];
  return {queued:true,id:row.id};
}

try{
  await pool.query(`INSERT INTO tender.portal_backfill_checkpoints(run_key,status,batch_size) VALUES($1,'RUNNING',$2) ON CONFLICT(run_key) DO UPDATE SET status='RUNNING',batch_size=excluded.batch_size,updated_at=now(),finished_at=NULL`,[runKey,batchSize]);
  const candidates=(await pool.query(candidatesSql)).rows;let examined=0,queued=0,skipped=0,failed=0;
  for(let offset=0;offset<candidates.length;offset+=batchSize){
    const batchJobs=[];
    for(const candidate of candidates.slice(offset,offset+batchSize)){
      try{const result=await queue(candidate);examined++;if(result.queued){queued++;batchJobs.push(result.id)}else skipped++;await pool.query("UPDATE tender.portal_backfill_checkpoints SET last_tender_id=$2,examined=$3,queued=$4,skipped=$5,failed=$6,updated_at=now() WHERE run_key=$1",[runKey,candidate.tender_id,examined,queued,skipped,failed])}catch(error){failed++;await pool.query("UPDATE tender.portal_backfill_checkpoints SET failed=$2,safe_detail=jsonb_build_object('errorCode',$3::text),updated_at=now() WHERE run_key=$1",[runKey,failed,String(error.code||"BACKFILL_ITEM_FAILED").slice(0,80)])}
    }
    if(!dryRun&&batchJobs.length){for(let poll=0;poll<240;poll++){const active=Number((await pool.query("SELECT count(*)::int n FROM tender.autopilot_queue WHERE id=ANY($1::uuid[]) AND status IN('PENDING','QUEUED','CLAIMED','RUNNING','RETRY')",[batchJobs])).rows[0].n);if(active===0)break;if(poll===239)throw Object.assign(Error("BACKFILL_BATCH_TIMEOUT"),{code:"BACKFILL_BATCH_TIMEOUT"});await new Promise(resolve=>setTimeout(resolve,5000))}}
  }
  await pool.query("UPDATE tender.portal_backfill_checkpoints SET status=$2,finished_at=now(),updated_at=now(),safe_detail=safe_detail||$3::jsonb WHERE run_key=$1",[runKey,failed?"FAILED":"COMPLETED",JSON.stringify({dryRun,candidates:candidates.length,externalWrite:false})]);
  console.log(JSON.stringify({runKey,dryRun,candidates:candidates.length,examined,queued,skipped,failed}));
  if(failed)process.exitCode=1;
}finally{await pool.end()}
