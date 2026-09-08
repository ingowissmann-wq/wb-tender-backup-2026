import crypto from 'node:crypto';
import {snapshotHash} from './canonical-truth.mjs';
import {withTenantContext,validTenantId} from './tenant-context.mjs';
import {parseBinaryDocument} from './binary-parsers.mjs';
import {discoverSourceRequirements,extractPages,REQUIREMENT_CLASSIFIER_VERSION} from './generic-final-preflight.mjs';
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function documentReviewPages(parsed){
 const pages=extractPages(parsed);if(pages.some(x=>String(typeof x==='string'?x:x.text||'').trim()))return pages;
 if(parsed.type==='DOCX')return [{page:null,text:[...(parsed.headers||[]),...(parsed.paragraphs||[]),...(parsed.footers||[])].map(x=>x.text).join('\n')}];
 if(parsed.type==='CSV')return [{page:null,text:(parsed.rows||[]).map(row=>row.join(' ')).join('\n')}];
 if(parsed.type==='XLSX')return (parsed.worksheets||[]).map(sheet=>({page:null,text:(sheet.rows||[]).flatMap(row=>(row.cells||[]).map(cell=>cell.value??'')).join('\n')}));
 return [];
}
export function reviewDocumentRequirements(requirements,decisions){
 if(!Array.isArray(decisions)||decisions.length!==requirements.length||new Set(decisions.map(x=>x?.key)).size!==requirements.length)throw fail('document_review_all_requirements_required');
 return requirements.map(requirement=>{
  const decision=decisions.find(x=>x?.key===requirement.requirementKey);
  if(!decision||!['VALIDATED','NOT_REQUIRED'].includes(decision.status)||typeof decision.reason!=='string'||decision.reason.trim().length<10||decision.reason.length>1000)throw fail('document_review_decision_invalid');
  if(decision.status==='VALIDATED'&&!validTenantId(decision.fileId))throw fail('document_review_evidence_required');
  return {...requirement,status:decision.status,evidenceFileId:decision.status==='VALIDATED'?decision.fileId:null,reviewReason:decision.reason.trim()};
 });
}
export function addSourceConfirmedRequirements(requirements, additions, files, lotKey){
 if(!Array.isArray(additions)||additions.length>100)throw fail('document_review_additions_invalid');
 const added=additions.map(item=>{
  if(!item||(item.page!=null&&(!Number.isInteger(item.page)||item.page<1))||typeof item.quote!=='string'||item.quote.trim().length<10||item.quote.length>1800||typeof item.title!=='string'||item.title.trim().length<3||item.title.length>200)throw fail('document_review_addition_invalid');
  const file=files.find(x=>x.id===item.fileId);if(!file)throw fail('document_review_source_file_required');
  const normalize=value=>String(value).replace(/\s+/g,' ').trim();
  const page=documentReviewPages(file.parsed).find(x=>(item.page==null||x.page===item.page||x.pageNumber===item.page)&&normalize(typeof x==='string'?x:x.text).includes(normalize(item.quote)));
  if(!page)throw fail('document_review_quote_not_in_source');
  const sourcePage=Number.isInteger(item.page)&&item.page>0?item.page:null;
  const sourceEvidenceSha256=digest(Buffer.from(file.id+'|'+sourcePage+'|'+normalize(item.quote)));
  return {requirementKey:'MANUAL:'+sourceEvidenceSha256,requirementKind:'REQUIRED_DOCUMENT',title:item.title.trim(),description:normalize(item.quote),sourceDocumentId:file.id,sourceReference:file.filename,sourcePage,sourceExcerpt:normalize(item.quote),sourceEvidenceSha256,scopeType:'LOT',lotKey,mandatory:true,submissionRelevant:true,status:'MISSING',classificationProvenance:{rule:'USER_CONFIRMED_SOURCE_QUOTE'}};
 });
 const result=[...requirements,...added];if(new Set(result.map(x=>x.requirementKey)).size!==result.length)throw fail('document_review_duplicate_requirement');return result;
}
export class TenantDocumentReview{
 constructor(pool,storage){this.pool=pool;this.storage=storage;}
 async assignment(db,context,id){
  const row=(await db.query('SELECT a.*,w.public_tender_id FROM tenant_portal.lot_assignment_versions a JOIN tenant_portal.tender_workspaces w ON w.tenant_id=a.tenant_id AND w.id=a.workspace_id WHERE a.tenant_id=$1 AND a.id=$2',[context.id,id])).rows[0];if(!row)throw fail('document_review_assignment_not_found',404);
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('tenant-tender:'||$1::text||':'||$2::text,0))",[context.id,row.public_tender_id]);
  const latest=(await db.query('SELECT id FROM tenant_portal.lot_assignment_versions WHERE tenant_id=$1 AND workspace_id=$2 AND lot_key=$3 ORDER BY version DESC LIMIT 1',[context.id,row.workspace_id,row.lot_key])).rows[0];
  const source=(await db.query('SELECT id FROM tender.tender_versions WHERE tender_id=$1 ORDER BY version DESC LIMIT 1',[row.public_tender_id])).rows[0];
  if(latest.id!==id||source?.id!==row.source_version_id||!['AUTOMATIC','MANUAL'].includes(row.assignment_kind)||!(await db.query('SELECT 1 FROM tender.current_participation_eligible_lots WHERE tender_id=$1 AND lot_key=$2',[row.public_tender_id,row.lot_key])).rowCount)throw fail('document_review_current_assignment_required',409);
  return row;
 }
 async files(db,tenantId,ids,{parse=false}={}){
  if(!this.storage?.configured)throw fail('document_review_storage_unavailable',503);
  if(!Array.isArray(ids)||ids.length<1||ids.length>30||new Set(ids).size!==ids.length||ids.some(x=>!validTenantId(x)))throw fail('document_review_file_selection_invalid');
  const rows=(await db.query('SELECT id,filename,media_type,sha256,size_bytes FROM tenant_portal.files WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[tenantId,ids])).rows;
  if(rows.length!==ids.length)throw fail('document_review_own_files_required',404);
  const result=[];
  for(const row of rows){
   if(Number(row.size_bytes)>10*1024*1024)throw fail('document_review_file_too_large');
   const buffer=await this.storage.get(tenantId,row.id);if(buffer.length!==Number(row.size_bytes)||digest(buffer)!==row.sha256)throw fail('document_review_file_integrity_failed',409);
   let parsed=null;
   if(parse){if(!/\.(pdf|docx|xlsx|csv|xml)$/i.test(row.filename))throw fail('document_review_format_unsupported');try{parsed=await parseBinaryDocument({buffer,name:row.filename,mediaType:row.media_type});}catch{throw fail('document_review_parse_failed');}
    if(parsed.ocrRequired||parsed.manualReview||parsed.status!=='VORHANDEN'||!documentReviewPages(parsed).some(x=>String(typeof x==='string'?x:x.text||'').trim()))throw fail('document_review_readable_source_required',409);
   }
   result.push({...row,parsed});
  }
  return result;
 }
 async get(context,assignmentId){
  if(!validTenantId(assignmentId))throw fail('document_review_assignment_not_found',404);
  return withTenantContext(this.pool,context,async db=>{
   const exists=(await db.query('SELECT id FROM tenant_portal.lot_assignment_versions WHERE tenant_id=$1 AND id=$2',[context.id,assignmentId])).rows[0];if(!exists)throw fail('document_review_assignment_not_found',404);
   return {files:(await db.query('SELECT id,filename,sha256 FROM tenant_portal.files WHERE tenant_id=$1 ORDER BY created_at DESC,id',[context.id])).rows,reviews:(await db.query('SELECT * FROM tenant_portal.lot_document_reviews WHERE tenant_id=$1 AND assignment_id=$2 ORDER BY version DESC',[context.id,assignmentId])).rows};
  });
 }
 async analyze(context,assignmentId,input){
  if(!validTenantId(assignmentId)||!validTenantId(input?.id)||input.confirmedLotScope!==true)throw fail('document_review_scope_confirmation_required');
  const requestHash=snapshotHash({assignmentId,files:input.fileIds,confirmed:true});
  return withTenantContext(this.pool,context,async db=>{
   const assignment=await this.assignment(db,context,assignmentId);
   const existing=(await db.query('SELECT * FROM tenant_portal.lot_document_reviews WHERE tenant_id=$1 AND id=$2',[context.id,input.id])).rows[0];if(existing){if(existing.request_sha256!==requestHash)throw fail('document_review_request_conflict',409);return existing;}
   await db.query("INSERT INTO tenant_portal.jobs(id,tenant_id,module_key,job_type,status,payload,created_by,claimed_at) VALUES($1,$2,'tender_autopilot','REVIEW_LOT_DOCUMENTS','RUNNING',$3,$4,now())",[input.id,context.id,{workspaceId:assignment.workspace_id,assignmentId},context.actorUserId]);
   const files=await this.files(db,context.id,input.fileIds,{parse:true});
   const manifest=files.map(file=>({id:file.id,filename:file.filename,sha256:file.sha256,parserVersion:file.parsed.parserVersion,sourceConfirmation:'USER_CONFIRMED_LOT_SOURCE'}));
   const requirements=files.flatMap(file=>discoverSourceRequirements({pages:documentReviewPages(file.parsed),sourceDocumentId:file.id,sourceReference:file.filename,lotKey:assignment.lot_key})).sort((a,b)=>a.requirementKey.localeCompare(b.requirementKey));
   const version=Number((await db.query('SELECT coalesce(max(version),0)+1 version FROM tenant_portal.lot_document_reviews WHERE tenant_id=$1 AND assignment_id=$2',[context.id,assignmentId])).rows[0].version);
   const snapshot={assignmentId,sourceVersionId:assignment.source_version_id,manifest,requirements,classifier:REQUIREMENT_CLASSIFIER_VERSION};
   const row=(await db.query("INSERT INTO tenant_portal.lot_document_reviews(id,tenant_id,assignment_id,version,status,source_manifest,requirements,request_sha256,snapshot_sha256,created_by) VALUES($1,$2,$3,$4,'REVIEW_REQUIRED',$5,$6,$7,$8,$9) RETURNING *",[input.id,context.id,assignmentId,version,JSON.stringify(manifest),JSON.stringify(requirements),requestHash,snapshotHash(snapshot),context.actorUserId])).rows[0];
   await db.query("UPDATE tenant_portal.jobs SET status='SUCCEEDED' WHERE tenant_id=$1 AND id=$2",[context.id,input.id]);
   for(const file of files)await db.query("INSERT INTO tenant_portal.lot_document_review_files(tenant_id,review_id,file_id,purpose) VALUES($1,$2,$3,'PROCUREMENT_SOURCE')",[context.id,row.id,file.id]);
   await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id,metadata) VALUES($1,$2,'LOT_DOCUMENTS_ANALYZED','document_review',$3,$4)",[context.id,context.actorUserId,row.id,{assignmentId,requirements:requirements.length,coverageConfirmed:false}]);return row;
  });
 }
 async preview(context,reviewId,input){
  if(!validTenantId(reviewId))throw fail('document_review_not_found',404);
  return withTenantContext(this.pool,context,async db=>{
   const review=(await db.query('SELECT * FROM tenant_portal.lot_document_reviews WHERE tenant_id=$1 AND id=$2',[context.id,reviewId])).rows[0];if(!review)throw fail('document_review_not_found',404);
   const assignment=await this.assignment(db,context,review.assignment_id);
   const files=await this.files(db,context.id,review.source_manifest.map(x=>x.id),{parse:true});
   return addSourceConfirmedRequirements(review.requirements,input?.additions,files,assignment.lot_key);
  });
 }
 async confirm(context,reviewId,input){
  if(!validTenantId(reviewId)||!validTenantId(input?.id)||input.coverageConfirmed!==true)throw fail('document_review_coverage_confirmation_required');
  const requestHash=snapshotHash({reviewId,decisions:input.decisions,additions:input.additions||[],coverageConfirmed:true});
  return withTenantContext(this.pool,context,async db=>{
   const source=(await db.query('SELECT * FROM tenant_portal.lot_document_reviews WHERE tenant_id=$1 AND id=$2',[context.id,reviewId])).rows[0];if(!source)throw fail('document_review_not_found',404);
   const assignment=await this.assignment(db,context,source.assignment_id);
   const existing=(await db.query('SELECT * FROM tenant_portal.lot_document_reviews WHERE tenant_id=$1 AND id=$2',[context.id,input.id])).rows[0];if(existing){if(existing.request_sha256!==requestHash)throw fail('document_review_request_conflict',409);return existing;}
   const latest=(await db.query('SELECT id FROM tenant_portal.lot_document_reviews WHERE tenant_id=$1 AND assignment_id=$2 ORDER BY version DESC LIMIT 1',[context.id,source.assignment_id])).rows[0];if(latest.id!==reviewId)throw fail('document_review_changed',409);
   const sourceFiles=await this.files(db,context.id,source.source_manifest.map(x=>x.id),{parse:true});
   const allRequirements=addSourceConfirmedRequirements(source.requirements,input.additions||[],sourceFiles,assignment.lot_key);
   const requirements=reviewDocumentRequirements(allRequirements,input.decisions);
   const evidenceIds=[...new Set(requirements.map(x=>x.evidenceFileId).filter(Boolean))];
   if(evidenceIds.length)await this.files(db,context.id,evidenceIds,{parse:true});
   await this.files(db,context.id,source.source_manifest.map(x=>x.id));
   const row=(await db.query("INSERT INTO tenant_portal.lot_document_reviews(id,tenant_id,assignment_id,version,status,source_manifest,requirements,request_sha256,snapshot_sha256,coverage_confirmed,created_by) VALUES($1,$2,$3,$4,'REVIEWED',$5,$6,$7,$8,true,$9) RETURNING *",[input.id,context.id,source.assignment_id,source.version+1,JSON.stringify(source.source_manifest),JSON.stringify(requirements),requestHash,snapshotHash({sourceSnapshot:source.snapshot_sha256,requirements,coverageConfirmed:true}),context.actorUserId])).rows[0];
   for(const file of source.source_manifest)await db.query("INSERT INTO tenant_portal.lot_document_review_files(tenant_id,review_id,file_id,purpose) VALUES($1,$2,$3,'PROCUREMENT_SOURCE')",[context.id,row.id,file.id]);
   for(const fileId of evidenceIds)await db.query("INSERT INTO tenant_portal.lot_document_review_files(tenant_id,review_id,file_id,purpose) VALUES($1,$2,$3,'BID_EVIDENCE')",[context.id,row.id,fileId]);
   await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id,metadata) VALUES($1,$2,'LOT_DOCUMENT_REQUIREMENTS_REVIEWED','document_review',$3,$4)",[context.id,context.actorUserId,row.id,{sourceReviewId:reviewId,coverageConfirmed:true}]);return row;
  });
 }
}
