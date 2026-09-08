import crypto from 'node:crypto';
import {CALCULATION_FORMULA_VERSION} from './sector-calculation.mjs';
import {snapshotHash} from './canonical-truth.mjs';
import {withTenantContext,validTenantId} from './tenant-context.mjs';
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
export function tenantManagementGate(row){
 const reasons=[];
 if(row.status!=='CALCULATED'||row.result?.status!=='CALCULATED')reasons.push('CALCULATION_INCOMPLETE');
 if(row.result?.formulaVersion!==CALCULATION_FORMULA_VERSION||row.result?.schemaVersion!==4)reasons.push('CALCULATION_FORMULA_CHANGED');
 const {calculationHash,...result}=row.result||{};
 if(!calculationHash||snapshotHash(result)!==calculationHash)reasons.push('CALCULATION_HASH_INVALID');
 if(row.id!==row.current_calculation_id)reasons.push('CALCULATION_CHANGED');
 if(row.assignment_id!==row.current_assignment_id||!['AUTOMATIC','MANUAL'].includes(row.assignment_kind))reasons.push('LOT_ASSIGNMENT_REVIEW_REQUIRED');
 if(row.source_version_id!==row.current_source_version_id)reasons.push('TENDER_SOURCE_CHANGED');
 if(!row.eligible)reasons.push('LOT_NO_LONGER_ELIGIBLE');
 if(!row.profile_current)reasons.push('COMPANY_PROFILE_CHANGED');
 return {ready:reasons.length===0,reasons};
}
export class TenantManagement{
 constructor(pool,storage){this.pool=pool;this.storage=storage;}
 async load(db,tenantId,calculationId=null){
  return (await db.query(`SELECT c.*,a.workspace_id,a.lot_key,a.company_id,a.profile_id,a.source_version_id,a.assignment_kind,t.title,t.buyer,company.display_name company_name,
   (SELECT id FROM tenant_portal.lot_calculation_versions newer WHERE newer.tenant_id=c.tenant_id AND newer.assignment_id=c.assignment_id ORDER BY version DESC LIMIT 1) current_calculation_id,
   (SELECT id FROM tenant_portal.lot_assignment_versions newer WHERE newer.tenant_id=a.tenant_id AND newer.workspace_id=a.workspace_id AND newer.lot_key=a.lot_key ORDER BY version DESC LIMIT 1) current_assignment_id,
   (SELECT id FROM tender.tender_versions newer WHERE newer.tender_id=w.public_tender_id ORDER BY version DESC LIMIT 1) current_source_version_id,
   EXISTS(SELECT 1 FROM tender.current_participation_eligible_lots eligible WHERE eligible.tender_id=w.public_tender_id AND eligible.lot_key=a.lot_key) eligible,
   company.status='ACTIVE' AND a.profile_id=(SELECT p.id FROM tenant_portal.company_profile_versions p WHERE p.tenant_id=a.tenant_id AND p.company_id=a.company_id AND p.service_line=profile.service_line AND p.valid_from<=(now() AT TIME ZONE 'UTC')::date AND (p.valid_until IS NULL OR p.valid_until>=(now() AT TIME ZONE 'UTC')::date) ORDER BY p.valid_from DESC,p.version DESC LIMIT 1) profile_current,
   decision.decision management_decision,decision.reason management_reason,decision.created_at management_at
   FROM tenant_portal.lot_calculation_versions c
   JOIN tenant_portal.lot_assignment_versions a ON a.tenant_id=c.tenant_id AND a.id=c.assignment_id
   JOIN tenant_portal.tender_workspaces w ON w.tenant_id=a.tenant_id AND w.id=a.workspace_id
   JOIN tender.tenders t ON t.id=w.public_tender_id
   JOIN saas.tenant_companies company ON company.tenant_id=a.tenant_id AND company.id=a.company_id
   JOIN tenant_portal.company_profile_versions profile ON profile.tenant_id=a.tenant_id AND profile.id=a.profile_id
   LEFT JOIN LATERAL(SELECT decision,reason,created_at FROM tenant_portal.management_decisions d WHERE d.tenant_id=c.tenant_id AND d.calculation_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) decision ON true
   WHERE c.tenant_id=$1 AND ($2::uuid IS NULL OR c.id=$2) ORDER BY c.created_at DESC,c.id DESC LIMIT 200`,[tenantId,calculationId])).rows.map(row=>({...row,gate:tenantManagementGate(row)}));
 }
 async list(context){return withTenantContext(this.pool,context,db=>this.load(db,context.id));}
 async decide(context,calculationId,input){
  if(!validTenantId(calculationId)||!validTenantId(input?.id)||!['APPROVED','REJECTED'].includes(input.decision)||input.confirmed!==true||typeof input.reason!=='string'||input.reason.trim().length<10||input.reason.length>1000)throw fail('management_decision_invalid');
  const requestHash=snapshotHash({calculationId,decision:input.decision,reason:input.reason.trim(),actor:context.actorUserId});
  return withTenantContext(this.pool,context,async db=>{
   const preliminary=(await this.load(db,context.id,calculationId))[0];if(!preliminary)throw fail('management_calculation_not_found',404);
   const workspace=(await db.query('SELECT public_tender_id FROM tenant_portal.tender_workspaces WHERE tenant_id=$1 AND id=$2',[context.id,preliminary.workspace_id])).rows[0];
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('tenant-tender:'||$1::text||':'||$2::text,0))",[context.id,workspace.public_tender_id]);
   const existing=(await db.query('SELECT * FROM tenant_portal.management_decisions WHERE tenant_id=$1 AND id=$2',[context.id,input.id])).rows[0];
   if(existing){if(existing.request_sha256!==requestHash)throw fail('management_request_conflict',409);return {decision:existing,idempotent:true};}
   const current=(await this.load(db,context.id,calculationId))[0];
   if(input.decision==='APPROVED'&&!current.gate.ready)throw fail('management_current_review_required',409);
   const files=(await db.query('SELECT f.id,f.sha256,f.filename,f.size_bytes FROM tenant_portal.lot_calculation_files binding JOIN tenant_portal.files f ON f.tenant_id=binding.tenant_id AND f.id=binding.file_id WHERE binding.tenant_id=$1 AND binding.calculation_id=$2 ORDER BY f.id',[context.id,calculationId])).rows;
   if(input.decision==='APPROVED'){
    if(!files.length||!this.storage?.configured)throw fail('management_sources_unavailable',409);
    for(const file of files){const bytes=await this.storage.get(context.id,file.id);if(bytes.length!==Number(file.size_bytes)||crypto.createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw fail('management_source_integrity_failed',409);}
   }
   const manifest={tenantId:context.id,workspaceId:current.workspace_id,sourceVersionId:current.source_version_id,lotKey:current.lot_key,companyId:current.company_id,profileId:current.profile_id,assignmentId:current.assignment_id,calculationId,calculationVersion:current.version,calculationHash:current.result.calculationHash||null,files:files.map(file=>({id:file.id,sha256:file.sha256})),scope:'CALCULATION_REVIEW',externalTransmission:false};
   const row=(await db.query('INSERT INTO tenant_portal.management_decisions(id,tenant_id,calculation_id,decision,reason,request_sha256,approved_payload_sha256,manifest,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[input.id,context.id,calculationId,input.decision,input.reason.trim(),requestHash,snapshotHash(manifest),manifest,context.actorUserId])).rows[0];
   await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,'management_decision',$4,$5)",[context.id,context.actorUserId,'MANAGEMENT_CALCULATION_'+input.decision,input.id,{calculationId,payloadHash:row.approved_payload_sha256}]);
   return {decision:row,idempotent:false};
  });
 }
}
