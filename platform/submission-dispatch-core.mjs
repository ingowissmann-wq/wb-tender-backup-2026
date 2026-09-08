import crypto from 'node:crypto';
import {canonicalJson,liveSubmissionHash} from './submission-live-core.mjs';

export const MANAGEMENT_RELEASE='MANAGEMENT_APPROVED_FOR_SUBMISSION';
export const DISPATCH_STATES=Object.freeze(['DRAFT','READY_FOR_MANAGEMENT',MANAGEMENT_RELEASE,'SUBMISSION_QUEUED','SUBMITTING','SUBMITTED','RETRY_REQUIRED','MANUAL_INTERVENTION_REQUIRED','DEADLINE_EXPIRED','CREDENTIALS_REQUIRED','PORTAL_CHANGED']);
export const DISPATCH_CONFIRMATION='Ich gebe dieses unveränderte Angebot für das angezeigte Los verbindlich zur automatischen Abgabe über das angezeigte Vergabeportal frei.';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha=/^[a-f0-9]{64}$/;
export const dispatchError=(code,statusCode=409)=>Object.assign(new Error(code),{code,statusCode});
export function requireDispatch(condition,code){if(!condition)throw dispatchError(code);}
export const bytesHash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function approvedDispatchBinding(input,{now=Date.now()}={}){
 const b=structuredClone(input);b.canonicalCompanyId||=b.companyId;
 for(const key of ['tenantId','companyId','canonicalCompanyId','tenderId','portalId','sourceId','releasedBy','calculationId'])requireDispatch(uuid.test(b[key]||''),'submission_'+key+'_invalid');
 requireDispatch(['LEGACY','TENANT_PORTAL'].includes(b.origin),'submission_origin_invalid');
 for(const key of ['lotKey','portalTenderReference','portalAdapterId','portalAdapterVersion'])requireDispatch(typeof b[key]==='string'&&b[key].trim()===b[key]&&b[key].length>0&&b[key].length<=300,'submission_'+key+'_invalid');
 for(const key of ['calculationVersion','packageVersion'])requireDispatch(Number.isSafeInteger(b[key])&&b[key]>0,'submission_'+key+'_invalid');
 for(const key of ['packageSha256','calculationSha256','sourceSha256'])requireDispatch(sha.test(b[key]||''),'submission_'+key+'_invalid');
 requireDispatch(Number.isFinite(Date.parse(b.deadlineAt))&&Date.parse(b.deadlineAt)>now,'submission_deadline_expired');
 requireDispatch(Number.isFinite(Date.parse(b.releasedAt))&&Math.abs(Date.parse(b.releasedAt)-now)<300000,'submission_release_time_invalid');
 let url;try{url=new URL(b.portalTenderUrl)}catch{throw dispatchError('submission_portal_url_invalid')}
 requireDispatch(url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443')&&url.hostname===b.portalHost,'submission_portal_binding_invalid');
 requireDispatch(![...url.searchParams.keys()].some(k=>/token|password|secret|session|cookie|authorization/i.test(k)),'submission_portal_url_sensitive');
 requireDispatch(Array.isArray(b.documents)&&b.documents.length>0&&b.documents.length<=100,'submission_documents_required');
 const ids=new Set(),names=new Set();
 for(const d of b.documents){
  requireDispatch(uuid.test(d.id)&&sha.test(d.sha256)&&Number.isSafeInteger(d.version)&&d.version>0&&Number.isSafeInteger(d.sizeBytes)&&d.sizeBytes>0,'submission_document_invalid');
  requireDispatch(typeof d.filename==='string'&&d.filename.length>0&&d.filename.length<=255&&!/[\x00-\x1f\x7f/\\]/.test(d.filename),'submission_document_name_invalid');
  requireDispatch(!ids.has(d.id)&&!names.has(d.filename),'submission_document_duplicate');ids.add(d.id);names.add(d.filename);
 }
 b.documents.sort((a,z)=>a.id.localeCompare(z.id));
 b.schemaVersion=1;b.releaseStatus=MANAGEMENT_RELEASE;
 return Object.freeze(b);
}
// Scope key deliberately excludes package, credentials, portal and approval IDs:
// a changed version or a different button request cannot silently create a second bid.
export const dispatchScopeKey=b=>liveSubmissionHash({tenantId:b.tenantId,companyId:b.canonicalCompanyId||b.companyId,tenderId:b.tenderId,lotKey:b.lotKey});
export function assertFrozenDispatch(row){
 requireDispatch(row.binding?.releaseStatus===MANAGEMENT_RELEASE,'submission_management_approval_required');
 requireDispatch(liveSubmissionHash(row.binding)===row.binding_sha256,'submission_binding_changed');
 requireDispatch(dispatchScopeKey(row.binding)===row.scope_key,'submission_scope_changed');
 for(const [column,key] of [['tenant_id','tenantId'],['company_id','companyId'],['tender_id','tenderId'],['portal_id','portalId'],['lot_key','lotKey'],['released_by','releasedBy'],['package_sha256','packageSha256']])requireDispatch(String(row[column])===String(row.binding[key]),'submission_scope_changed');
 return row.binding;
}
export function assertDispatchDocuments(binding,documents){
 requireDispatch(Array.isArray(documents)&&documents.length===binding.documents.length,'submission_document_manifest_changed');
 for(const expected of binding.documents){
  const matching=documents.filter(d=>d.id===expected.id);requireDispatch(matching.length===1,'submission_document_manifest_changed');
  const d=matching[0];requireDispatch(Buffer.isBuffer(d.buffer)&&d.buffer.length===expected.sizeBytes&&bytesHash(d.buffer)===expected.sha256&&d.filename===expected.filename&&d.version===expected.version,'submission_document_bytes_changed');
 }
 return true;
}
export function dispatchFailure(error,{commitStarted=false,deadlineAt,attempt=0,now=Date.now()}={}){
 const code=String(error?.code||error?.message||'submission_operation_failed');
 // After a possible final request only read-only receipt reconciliation is safe.
 if(commitStarted)return {status:'MANUAL_INTERVENTION_REQUIRED',code:'submission_receipt_reconciliation_required',retry:false,reconcile:true};
 if(Date.parse(deadlineAt)<=now||code==='submission_deadline_expired')return {status:'DEADLINE_EXPIRED',code:'submission_deadline_expired',retry:false};
 if(/credential|LOGIN_REQUIRED|BENUTZERNAME_ODER_PASSWORT_FALSCH/i.test(code))return {status:'CREDENTIALS_REQUIRED',code:'submission_credentials_required',retry:false};
 if(/portal_changed|LOGIN_FORMULAR_GEAENDERT/i.test(code))return {status:'PORTAL_CHANGED',code:'submission_portal_changed',retry:false};
 if(['submission_network_unavailable','submission_upload_interrupted'].includes(code)&&attempt<4){
  const delayMs=Math.min(120000,5000*2**attempt);
  if(now+delayMs+60000<Date.parse(deadlineAt))return {status:'RETRY_REQUIRED',code,retry:true,retryAt:new Date(now+delayMs).toISOString()};
 }
 return {status:'MANUAL_INTERVENTION_REQUIRED',code:new Set(['submission_approved_source_changed','submission_scope_changed','submission_document_bytes_changed','submission_document_manifest_changed','submission_management_permission_required','submission_paid_access_required','submission_product_entitlement_required','submission_adapter_not_validated','submission_lease_lost','submission_portal_binding_invalid','submission_legacy_preflight_failed']).has(code)?code:'submission_operation_failed',retry:false};
}
export function verifyDispatchReceipt(binding,result){
 requireDispatch(result?.verified===true&&typeof result.reference==='string'&&result.reference.trim().length>0&&result.reference.length<=200,'submission_receipt_missing');
 requireDispatch(result.portalHost===binding.portalHost&&result.tenderReference===binding.portalTenderReference&&result.lotKey===binding.lotKey&&result.packageSha256===binding.packageSha256,'submission_receipt_scope_mismatch');
 requireDispatch(Number.isFinite(Date.parse(result.submittedAt))&&Date.parse(result.submittedAt)>=Date.parse(binding.releasedAt)&&Date.parse(result.submittedAt)<=Date.parse(binding.deadlineAt)&&Date.parse(result.submittedAt)<=Date.now()+5000,'submission_receipt_time_invalid');
 requireDispatch(Buffer.isBuffer(result.bytes)&&result.bytes.length>0&&result.bytes.length<=20*1024*1024,'submission_receipt_bytes_required');
 requireDispatch(canonicalJson(result.documents)===canonicalJson(binding.documents),'submission_receipt_document_mismatch');
 return {reference:result.reference,submittedAt:new Date(result.submittedAt).toISOString(),sha256:bytesHash(result.bytes),mediaType:result.mediaType==='application/pdf'?'application/pdf':'application/json',bytes:result.bytes,documents:binding.documents};
}
