import crypto from 'node:crypto';
import {snapshotHash} from './canonical-truth.mjs';
import {withTenantContext,validTenantId} from './tenant-context.mjs';
import {parseBinaryDocument} from './binary-parsers.mjs';
import {calculateSectorTender} from './sector-calculation.mjs';
import {buildTenantCalculationSources,requiredCalculationBindings} from './tenant-calculation-sources.mjs';
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
export class TenantLotCalculations{
 constructor(pool,storage){this.pool=pool;this.storage=storage;}
 async context(context,assignmentId){
  if(!validTenantId(assignmentId))throw fail('calculation_assignment_not_found',404);
  return withTenantContext(this.pool,context,async db=>{
   const row=(await db.query('SELECT a.*,p.parameters,p.service_line,p.version profile_version FROM tenant_portal.lot_assignment_versions a JOIN tenant_portal.company_profile_versions p ON p.tenant_id=a.tenant_id AND p.company_id=a.company_id AND p.id=a.profile_id WHERE a.tenant_id=$1 AND a.id=$2',[context.id,assignmentId])).rows[0];if(!row)throw fail('calculation_assignment_not_found',404);
   const files=(await db.query("SELECT id,filename,sha256 FROM tenant_portal.files WHERE tenant_id=$1 AND lower(filename) LIKE '%.xlsx' ORDER BY created_at DESC,id",[context.id])).rows;
   const calculations=(await db.query('SELECT id,version,status,result,created_at FROM tenant_portal.lot_calculation_versions WHERE tenant_id=$1 AND assignment_id=$2 ORDER BY version DESC',[context.id,assignmentId])).rows;
   return {assignment:row,required:requiredCalculationBindings(row.parameters),files,calculations};
  });
 }
 async create(context,assignmentId,input){
  if(!validTenantId(assignmentId)||!validTenantId(input?.id)||input.confirmed!==true||!Array.isArray(input.bindings)||input.bindings.length<2||input.bindings.length>100)throw fail('calculation_input_invalid');
  if(!this.storage?.configured)throw fail('calculation_storage_unavailable',503);
  const fileIds=[...new Set(input.bindings.map(x=>x?.fileId))].sort();
  if(fileIds.length>10||fileIds.some(x=>!validTenantId(x)))throw fail('calculation_file_selection_invalid');
  const fingerprint=snapshotHash({assignmentId,bindings:input.bindings,confirmed:true});
  return withTenantContext(this.pool,context,async db=>{
   const selected=(await db.query('SELECT a.*,w.public_tender_id FROM tenant_portal.lot_assignment_versions a JOIN tenant_portal.tender_workspaces w ON w.tenant_id=a.tenant_id AND w.id=a.workspace_id WHERE a.tenant_id=$1 AND a.id=$2',[context.id,assignmentId])).rows[0];if(!selected)throw fail('calculation_assignment_not_found',404);
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('tenant-tender:'||$1::text||':'||$2::text,0))",[context.id,selected.public_tender_id]);
   const existing=(await db.query('SELECT * FROM tenant_portal.lot_calculation_versions WHERE tenant_id=$1 AND id=$2',[context.id,input.id])).rows[0];
   if(existing){if(existing.request_sha256!==fingerprint)throw fail('calculation_request_conflict',409);return {calculation:existing,idempotent:true};}
   const latest=(await db.query('SELECT id FROM tenant_portal.lot_assignment_versions WHERE tenant_id=$1 AND workspace_id=$2 AND lot_key=$3 ORDER BY version DESC LIMIT 1',[context.id,selected.workspace_id,selected.lot_key])).rows[0];
   if(latest.id!==assignmentId||!['AUTOMATIC','MANUAL'].includes(selected.assignment_kind))throw fail('calculation_assignment_review_required',409);
   const source=(await db.query('SELECT id FROM tender.tender_versions WHERE tender_id=$1 ORDER BY version DESC LIMIT 1',[selected.public_tender_id])).rows[0];
   if(source?.id!==selected.source_version_id||!(await db.query('SELECT 1 FROM tender.current_participation_eligible_lots WHERE tender_id=$1 AND lot_key=$2',[selected.public_tender_id,selected.lot_key])).rowCount)throw fail('calculation_source_changed_or_expired',409);
   const profile=(await db.query("SELECT p.*,to_char((now() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') effective_date FROM tenant_portal.company_profile_versions p JOIN saas.tenant_companies c ON c.tenant_id=p.tenant_id AND c.id=p.company_id WHERE p.tenant_id=$1 AND p.id=$2 AND c.status='ACTIVE' AND p.valid_from<=(now() AT TIME ZONE 'UTC')::date AND (p.valid_until IS NULL OR p.valid_until>=(now() AT TIME ZONE 'UTC')::date)",[context.id,selected.profile_id])).rows[0];if(!profile)throw fail('calculation_profile_not_current',409);
   const files=(await db.query('SELECT id,filename,media_type,sha256,size_bytes FROM tenant_portal.files WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[context.id,fileIds])).rows;
   if(files.length!==fileIds.length)throw fail('calculation_own_files_required',404);
   if(files.some(x=>!x.filename.toLowerCase().endsWith('.xlsx')||Number(x.size_bytes)>10*1024*1024))throw fail('calculation_xlsx_source_required');
   await db.query("INSERT INTO tenant_portal.jobs(id,tenant_id,module_key,job_type,status,payload,created_by,claimed_at) VALUES($1,$2,'tender_autopilot','CALCULATE_LOT','RUNNING',$3,$4,now())",[input.id,context.id,{workspaceId:selected.workspace_id,assignmentId},context.actorUserId]);
   const documents=[];
   for(const file of files){
    const bytes=await this.storage.get(context.id,file.id);if(bytes.length!==Number(file.size_bytes)||hash(bytes)!==file.sha256)throw fail('calculation_file_integrity_failed',409);
    let parsed;try{parsed=await parseBinaryDocument({buffer:bytes,name:file.filename,mediaType:file.media_type});}catch{throw fail('calculation_document_parse_failed');}
    documents.push({...file,parsed});
   }
   const built=buildTenantCalculationSources({documents,bindings:input.bindings,parameters:profile.parameters});
   const provenance={...built.provenance,assignmentId,profileId:profile.id,sourceVersionId:selected.source_version_id,lotKey:selected.lot_key,userConfirmedBy:context.actorUserId};
   const result=built.missing.length?{status:'CALCULATION_BLOCKED_MISSING_INPUT',missing:built.missing,externalTransmission:false}:calculateSectorTender({serviceArea:profile.service_line,parameters:profile.parameters,effectiveAt:profile.effective_date,facts:built.facts,provenance});
   const version=Number((await db.query('SELECT coalesce(max(version),0)+1 version FROM tenant_portal.lot_calculation_versions WHERE tenant_id=$1 AND assignment_id=$2',[context.id,assignmentId])).rows[0].version);
   const calculated=result.status==='CALCULATED';
   const row=(await db.query('INSERT INTO tenant_portal.lot_calculation_versions(id,tenant_id,assignment_id,version,request_sha256,status,bindings,facts,provenance,result,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[input.id,context.id,assignmentId,version,fingerprint,calculated?'CALCULATED':'BLOCKED',JSON.stringify(input.bindings),built.facts,provenance,result,context.actorUserId])).rows[0];
   for(const fileId of fileIds)await db.query('INSERT INTO tenant_portal.lot_calculation_files(tenant_id,calculation_id,file_id) VALUES($1,$2,$3)',[context.id,input.id,fileId]);
   await db.query('UPDATE tenant_portal.jobs SET status=$3 WHERE tenant_id=$1 AND id=$2',[context.id,input.id,calculated?'SUCCEEDED':'FAILED']);
   await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,'lot_calculation',$4,$5)",[context.id,context.actorUserId,calculated?'LOT_CALCULATED':'LOT_CALCULATION_BLOCKED',input.id,{assignmentId,version,formulaVersion:result.formulaVersion||null}]);
   return {calculation:row,idempotent:false};
  });
 }
}
