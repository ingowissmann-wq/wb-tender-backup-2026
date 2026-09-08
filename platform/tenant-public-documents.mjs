import crypto from 'node:crypto';
import {withTenantContext,validTenantId} from './tenant-context.mjs';
import {snapshotHash} from './canonical-truth.mjs';
import {TenantDocumentReview} from './tenant-document-review.mjs';
import {fetchPublicDocument} from './public-document-fetch.mjs';
import {scanBuffer} from './malware-scanner.mjs';
import {parseBinaryDocument} from './binary-parsers.mjs';
const fail=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const selection=`SELECT id,original_url,final_url,evidence_sha256,source_lot_id FROM tender.tender_external_links
 WHERE tender_id=$1 AND tender_version_id=$2 AND source_lot_id=$3 AND role='PROCUREMENT_DOCUMENT'
 AND public_access=true AND verification_status='HTTP_VERIFIED'`;
export class TenantPublicDocuments{
 constructor(pool,storage,{fetchDocument=fetchPublicDocument,scan=scanBuffer}={}){this.pool=pool;this.storage=storage;this.fetchDocument=fetchDocument;this.scan=scan;this.review=new TenantDocumentReview(pool,storage);}
 async list(context,assignmentId){
  if(!validTenantId(assignmentId))throw fail('document_fetch_assignment_not_found',404);
  return withTenantContext(this.pool,context,async db=>{
   const assignment=await this.review.assignment(db,context,assignmentId);
   const links=(await db.query(selection+' ORDER BY id',[assignment.public_tender_id,assignment.source_version_id,assignment.lot_key])).rows;
   const jobs=(await db.query("SELECT id,status,payload->>'errorCode' error_code,payload->>'fileId' file_id,created_at FROM tenant_portal.jobs WHERE tenant_id=$1 AND job_type='FETCH_PUBLIC_LOT_DOCUMENT' AND payload->>'assignmentId'=$2 ORDER BY created_at DESC LIMIT 100",[context.id,assignmentId])).rows;
   return {links:links.map(x=>({id:x.id,host:new URL(x.final_url||x.original_url).hostname,lotKey:x.source_lot_id})),jobs};
  });
 }
 async fetch(context,assignmentId,input){
  if(!validTenantId(assignmentId)||!validTenantId(input?.id)||!validTenantId(input?.linkId))throw fail('document_fetch_input_invalid',400);
  if(!this.storage?.configured)throw fail('document_fetch_storage_unavailable',503);
  const requestHash=snapshotHash({assignmentId,linkId:input.linkId});
  const prepared=await withTenantContext(this.pool,context,async db=>{
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('tenant-document-fetch:'||$1::text||':'||$2::text,0))",[context.id,input.id]);
   const previous=(await db.query('SELECT * FROM tenant_portal.jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[context.id,input.id])).rows[0];
   if(previous){if(previous.job_type!=='FETCH_PUBLIC_LOT_DOCUMENT'||previous.payload.requestHash!==requestHash)throw fail('document_fetch_request_conflict');return {previous};}
   const assignment=await this.review.assignment(db,context,assignmentId);
   const link=(await db.query(selection+' AND id=$4',[assignment.public_tender_id,assignment.source_version_id,assignment.lot_key,input.linkId])).rows[0];
   if(!link)throw fail('document_fetch_public_lot_source_required',404);
   const payload={assignmentId,workspaceId:assignment.workspace_id,linkId:link.id,sourceVersionId:assignment.source_version_id,sourceEvidenceSha256:link.evidence_sha256,requestHash};
   await db.query("INSERT INTO tenant_portal.jobs(id,tenant_id,module_key,job_type,status,payload,created_by,claimed_at) VALUES($1,$2,'tender_autopilot','FETCH_PUBLIC_LOT_DOCUMENT','RUNNING',$3,$4,now())",[input.id,context.id,payload,context.actorUserId]);
   await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id,metadata) VALUES($1,$2,'PUBLIC_DOCUMENT_FETCH_STARTED','tenant_job',$3,$4)",[context.id,context.actorUserId,input.id,{assignmentId,linkId:link.id}]);
   return {link,payload};
  });
  if(prepared.previous){
   const row=prepared.previous;
   return {id:row.id,status:row.status,fileId:row.status==='SUCCEEDED'?row.payload.fileId:null,errorCode:row.payload.errorCode||null,idempotent:true};
  }
  try{
   const downloaded=await this.fetchDocument(prepared.link.final_url||prepared.link.original_url);
   if(!Buffer.isBuffer(downloaded.bytes)||downloaded.bytes.length>10*1024*1024)throw fail('document_fetch_size_invalid');
   const scan=await this.scan(downloaded.bytes);if(scan.status!=='CLEAN')throw fail(scan.status==='INFECTED'?'document_fetch_malware_rejected':'document_fetch_scanner_unavailable',503);
   let parsed;try{parsed=await parseBinaryDocument({buffer:downloaded.bytes,name:downloaded.filename,mediaType:downloaded.mediaType});}catch{throw fail('document_fetch_parse_failed')}
   if(parsed.status!=='VORHANDEN')throw fail('document_fetch_parse_failed');
   return await withTenantContext(this.pool,context,async db=>{
    const assignment=await this.review.assignment(db,context,assignmentId);
    const link=(await db.query(selection+' AND id=$4',[assignment.public_tender_id,assignment.source_version_id,assignment.lot_key,input.linkId])).rows[0];
    if(!link||snapshotHash(link)!==snapshotHash(prepared.link))throw fail('document_fetch_source_changed');
    const stored=await this.storage.put(context.id,downloaded.bytes,{objectId:input.id});
    const reread=await this.storage.get(context.id,input.id);if(sha(reread)!==stored.sha256||reread.length!==downloaded.bytes.length)throw fail('document_fetch_readback_failed');
    await db.query('INSERT INTO tenant_portal.files(id,tenant_id,storage_key,filename,media_type,size_bytes,sha256,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[input.id,context.id,stored.storageKey,downloaded.filename,downloaded.mediaType,stored.sizeBytes,stored.sha256,context.actorUserId]);
    await db.query('INSERT INTO tenant_portal.tender_documents(id,tenant_id,workspace_id,storage_key,filename,sha256,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[input.id,context.id,assignment.workspace_id,stored.storageKey,downloaded.filename,stored.sha256,context.actorUserId]);
    await db.query("UPDATE tenant_portal.jobs SET status='SUCCEEDED',payload=payload||$3::jsonb WHERE tenant_id=$1 AND id=$2",[context.id,input.id,{fileId:input.id,sha256:stored.sha256,parserVersion:parsed.parserVersion,malwareScanStatus:'CLEAN'}]);
    await db.query("INSERT INTO tenant_portal.storage_audit(tenant_id,file_id,action,actor_user_id) VALUES($1,$2,'UPLOAD',$3)",[context.id,input.id,context.actorUserId]);
    await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id,metadata) VALUES($1,$2,'PUBLIC_DOCUMENT_FETCH_SUCCEEDED','tenant_job',$3,$4)",[context.id,context.actorUserId,input.id,{assignmentId,linkId:link.id,sha256:stored.sha256,readbackVerified:true,authenticated:false}]);
    return {id:input.id,status:'SUCCEEDED',fileId:input.id,idempotent:false};
   });
  }catch(error){
   const errorCode=/^document_(fetch|review)_[a-z_]+$/.test(error.message)?error.message:'document_fetch_operation_failed';
   await withTenantContext(this.pool,context,async db=>{
    // A lost COMMIT response must never turn a committed success into failure.
    const changed=await db.query("UPDATE tenant_portal.jobs SET status='FAILED',payload=payload||$3::jsonb WHERE tenant_id=$1 AND id=$2 AND status='RUNNING' RETURNING id",[context.id,input.id,{errorCode}]);
    if(changed.rowCount)await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id,metadata) VALUES($1,$2,'PUBLIC_DOCUMENT_FETCH_FAILED','tenant_job',$3,$4)",[context.id,context.actorUserId,input.id,{errorCode}]);
   });
   throw fail(errorCode,error.statusCode||503);
  }
 }
}
