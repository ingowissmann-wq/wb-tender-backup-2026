import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import {createFixedScopedPool,loadBackgroundScope} from "../platform/scoped-pg-pool.mjs";

const TARGETS=["540350-2026","552392-2026"];
const apply=process.argv.includes("--apply");
const expected=process.argv.find(value=>value.startsWith("--expected-plan-sha256="))?.split("=")[1]||"";
const stable=value=>Array.isArray(value)?`[${value.map(stable).join(",")}]`:value&&typeof value==="object"?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`:JSON.stringify(value);
const hash=value=>crypto.createHash("sha256").update(stable(value)).digest("hex");
const connectionString=process.env.DATABASE_URL||fs.readFileSync(process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8").trim();
const rawPool=new pg.Pool({connectionString,max:1,options:[!apply?"-c default_transaction_read_only=on":"","-c statement_timeout=60000",process.env.DATABASE_SESSION_OPTIONS].filter(Boolean).join(" ")});
const pool=createFixedScopedPool(rawPool,await loadBackgroundScope(rawPool)).pool;
const safety=(await pool.query("SELECT external_submission_enabled,allow_external_submission,global_kill_switch FROM tender.submission_runtime_settings")).rows[0];
if(safety?.external_submission_enabled||safety?.allow_external_submission||safety?.global_kill_switch!==true)throw new Error("submission_safety_not_locked");
const contexts=(await pool.query(`SELECT tender.id tender_id,tender.external_id,tender.notice_number,context.tenant_id,context.company_id,
    context.lot_id,context.lot_key,context.enrichment_version_id,scope.canonical_service,
    relevance.evaluation_version assessment_version_id,version.id tender_version_id,resolution.portal_id,
    portal.adapter_id,portal.adapter_version
  FROM tender.tenders tender
  JOIN tender.pipeline_contexts context ON context.tender_id=tender.id AND context.pipeline_version='wb-tender-pipeline/5.0.0'
    AND context.context_integrity_status='CANONICAL' AND context.lot_id IS NOT NULL AND context.enrichment_version_id IS NOT NULL
  JOIN tender.configuration_scopes scope ON scope.tenant_id=context.tenant_id AND scope.company_id=context.company_id
  JOIN tender.enterprise_company_links company ON company.company_id=context.company_id AND company.tender_profile_id=scope.profile_id
  JOIN tender.service_relevance_evaluations relevance ON relevance.tender_id=tender.id AND relevance.company_id=context.company_id
    AND relevance.primary_company=true AND relevance.relevance_status='RELEVANT' AND relevance.service_scope_gate='PASSED'
    AND relevance.recommendation='FULL_PIPELINE_ALLOWED'
    AND (relevance.lot_key=context.lot_key OR relevance.lot_key IS NULL)
    AND NOT EXISTS(SELECT 1 FROM tender.service_relevance_evaluations newer WHERE newer.tender_id=relevance.tender_id
      AND newer.company_id=relevance.company_id AND newer.lot_key IS NOT DISTINCT FROM relevance.lot_key
      AND newer.evaluation_version>relevance.evaluation_version)
  JOIN LATERAL(SELECT candidate.id FROM tender.tender_versions candidate WHERE candidate.tender_id=tender.id ORDER BY candidate.version DESC LIMIT 1)version ON true
  JOIN tender.tender_portal_resolutions resolution ON resolution.tender_id=tender.id AND resolution.tender_version_id=version.id
    AND resolution.evidence_role='PROCUREMENT_DOCUMENT' AND resolution.resolution_status='UNIQUE_EVIDENCE'
  JOIN tender.portal_registry portal ON portal.id=resolution.portal_id AND portal.adapter_enabled=true
    AND portal.adapter_validation_status='VALIDATED_READ_ONLY'
    AND 'PUBLIC_DOCUMENTS_POSSIBLE'=ANY(coalesce(portal.capabilities,'{}'::text[]))
  WHERE tender.external_id=ANY($1::text[]) AND tender.source_code='TED'
    AND tender.source_lifecycle_status='ACTIVE' AND tender.participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE')
    AND EXISTS(SELECT 1 FROM tender.tender_lot_selections selection WHERE selection.tenant_id=context.tenant_id
      AND selection.company_id=context.company_id AND selection.tender_id=tender.id AND selection.lot_id=context.lot_id
      AND selection.source_lot_id=context.lot_key)
    AND EXISTS(SELECT 1 FROM tender.tender_external_links link WHERE link.tender_id=tender.id
      AND link.role='PROCUREMENT_DOCUMENT' AND link.public_access=true
      AND link.verification_status IN('DISCOVERED','HTTP_VERIFIED')
      AND lower(coalesce(link.final_host,link.original_host))='vergabe.muenchen.de')
  ORDER BY tender.external_id,(relevance.lot_key IS NOT DISTINCT FROM context.lot_key) DESC`,[TARGETS])).rows;
const unique=[...new Map(contexts.map(row=>[row.external_id,row])).values()];
if(unique.length!==TARGETS.length||TARGETS.some(id=>!unique.some(row=>row.external_id===id)))throw new Error("public_document_context_inventory_incomplete");
const plan={schemaVersion:1,actionType:"FETCH_DOCUMENTS",contexts:unique.map(row=>({
  tenderId:row.tender_id,externalId:row.external_id,tenantId:row.tenant_id,companyId:row.company_id,
  lotId:row.lot_id,lotKey:row.lot_key,enrichmentVersionId:row.enrichment_version_id,
  assessmentVersionId:Number(row.assessment_version_id),tenderVersionId:row.tender_version_id,
  portalId:row.portal_id,adapterId:row.adapter_id,adapterVersion:row.adapter_version,
})),credentialIds:[],externalWrite:false,externalSubmission:false,transmitted:false};
const planSha256=hash(plan);
if(!apply){console.log(JSON.stringify({mode:"READ_ONLY_PLAN",planSha256,plan,safety,requiredApplyArgument:`--expected-plan-sha256=${planSha256}`},null,2));await rawPool.end();process.exit(0)}
if(expected!==planSha256)throw new Error("public_document_plan_hash_mismatch");
const client=await pool.connect();let inserted=0,skipped=0;
try{
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ted-munich-public-documents',0))");
  const lockedSafety=(await client.query("SELECT external_submission_enabled,allow_external_submission,global_kill_switch FROM tender.submission_runtime_settings FOR SHARE")).rows[0];
  if(lockedSafety.external_submission_enabled||lockedSafety.allow_external_submission||lockedSafety.global_kill_switch!==true)throw new Error("submission_safety_changed");
  for(const row of unique){
    const idempotencyKey=`TED_MUNICH_PUBLIC_FETCH:${row.tender_id}:${row.company_id}:${row.lot_key}:${row.enrichment_version_id}`;
    const result=await client.query(`INSERT INTO tender.autopilot_queue(request_id,action_type,tender_id,tender_version_id,notice_id,
      lot_id,lot_key,company_id,service_scope,portal_id,credential_id,enrichment_version_id,assessment_version_id,
      configuration_version_id,idempotency_key,reason,status,current_step,next_step,created_by)
      VALUES(gen_random_uuid(),'FETCH_DOCUMENTS',$1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,'UNVERSIONED',$11,
        'AUTHORITATIVE_PUBLIC_MUNICH_DOCUMENT_DOWNLOAD','QUEUED','QUEUED','FETCH_DOCUMENTS',NULL)
      ON CONFLICT DO NOTHING RETURNING id`,[row.tender_id,row.tender_version_id,row.notice_number||row.external_id,row.lot_id,
      row.lot_key,row.company_id,row.canonical_service,row.portal_id,row.enrichment_version_id,row.assessment_version_id,idempotencyKey]);
    if(result.rowCount===1)inserted++;else skipped++;
  }
  await client.query("INSERT INTO tender.audit_events(action,metadata) VALUES('TED_MUNICH_PUBLIC_DOCUMENT_JOBS_QUEUED',$1::jsonb)",
    [JSON.stringify({planSha256,inserted,skipped,actionType:"FETCH_DOCUMENTS",credentialIds:[],externalWrite:false,externalSubmission:false,transmitted:false})]);
  await client.query("COMMIT");
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{client.release();await rawPool.end()}
console.log(JSON.stringify({mode:"APPLIED",planSha256,inserted,skipped,externalWrite:false,externalSubmission:false,transmitted:false},null,2));
