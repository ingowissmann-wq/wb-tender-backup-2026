import crypto from 'node:crypto';
import path from 'node:path';
import JSZip from 'jszip';
import {snapshotHash} from './canonical-truth.mjs';
import {withTenantContext,validTenantId} from './tenant-context.mjs';
import {TenantManagement} from './tenant-management.mjs';
import {TenantDocumentReview} from './tenant-document-review.mjs';
import {normalizeDecimal} from './unit-catalog.mjs';
import {validateRequiredSpreadsheetInputs} from './spreadsheet-required-inputs.mjs';
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const digest=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
export function verifyOfferPrice(document,binding,expected){
 if(!binding||binding.fileId!==document.id||typeof binding.sheet!=='string'||!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(binding.cell||''))throw fail('offer_package_price_binding_required');
 const sheets=document.parsed?.worksheets?.filter(x=>x.name===binding.sheet)||[];
 const cells=sheets.length===1?sheets[0].rows.flatMap(x=>x.cells||[]).filter(x=>x.address===binding.cell):[];
 if(cells.length!==1||cells[0].formula||normalizeDecimal(cells[0].value)!==expected)throw fail('offer_package_price_mismatch');
 const validation=validateRequiredSpreadsheetInputs([{id:document.id,payload_sha256:document.sha256,procurement_verification_status:'VERIFIED',extracted_data:document.parsed}]);
 if(validation.missing.length)throw fail('offer_package_price_required_cells_missing');
 return {fileId:document.id,sha256:document.sha256,sheet:binding.sheet,cell:binding.cell,value:expected,currency:'EUR',tax:'NET',confirmation:'USER_CONFIRMED_TENDER_PRICE_FIELD'};
}
export async function offerPackageZip(manifest,files){
 const zip=new JSZip(),date=new Date('1980-01-01T00:00:00Z');
 for(const file of files){if(digest(file.buffer)!==file.sha256)throw fail('offer_package_file_integrity_failed',409);const basename=path.basename(file.filename.replaceAll('\\','/')).replace(/[\x00-\x1f\x7f]/g,'_');zip.file('Angebot/'+file.id+'-'+basename,file.buffer,{date});}
 zip.file('Pruefnachweis.json',JSON.stringify(manifest,null,2)+'\n',{date});
 return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE',compressionOptions:{level:6}});
}
export class TenantOfferPackage{
 constructor(pool,storage){this.pool=pool;this.storage=storage;this.management=new TenantManagement(pool,storage);this.documents=new TenantDocumentReview(pool,storage);}
 async context(db,context,calculationId){
  const preliminary=(await this.management.load(db,context.id,calculationId))[0];if(!preliminary)throw fail('offer_package_calculation_not_found',404);
  await this.documents.assignment(db,context,preliminary.assignment_id);
  const calculation=(await this.management.load(db,context.id,calculationId))[0];
  if(!calculation.gate.ready||calculation.management_decision!=='APPROVED')throw fail('offer_package_current_calculation_approval_required',409);
  const decision=(await db.query('SELECT * FROM tenant_portal.management_decisions WHERE tenant_id=$1 AND calculation_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[context.id,calculationId])).rows[0];
  if(decision.decision!=='APPROVED'||snapshotHash(decision.manifest)!==decision.approved_payload_sha256||decision.manifest.calculationHash!==calculation.result.calculationHash)throw fail('offer_package_calculation_approval_invalid',409);
  const review=(await db.query('SELECT * FROM tenant_portal.lot_document_reviews WHERE tenant_id=$1 AND assignment_id=$2 ORDER BY version DESC LIMIT 1',[context.id,calculation.assignment_id])).rows[0];
  if(!review||review.status!=='REVIEWED'||!review.coverage_confirmed||review.requirements.some(x=>!['VALIDATED','NOT_REQUIRED'].includes(x.status)))throw fail('offer_package_document_review_required',409);
  const sourceIds=[...new Set([...review.source_manifest.map(x=>x.id),...decision.manifest.files.map(x=>x.id)])];await this.documents.files(db,context.id,sourceIds);
  return {calculation,decision,review};
 }
 async list(context,calculationId){
  if(!validTenantId(calculationId))throw fail('offer_package_calculation_not_found',404);
  return withTenantContext(this.pool,context,async db=>{
   if(!(await db.query('SELECT 1 FROM tenant_portal.lot_calculation_versions WHERE tenant_id=$1 AND id=$2',[context.id,calculationId])).rowCount)throw fail('offer_package_calculation_not_found',404);
   return {files:(await db.query('SELECT id,filename,sha256 FROM tenant_portal.files WHERE tenant_id=$1 ORDER BY created_at DESC,id',[context.id])).rows,packages:(await db.query('SELECT p.*,d.decision FROM tenant_portal.offer_packages p LEFT JOIN LATERAL(SELECT decision FROM tenant_portal.offer_package_decisions WHERE tenant_id=p.tenant_id AND package_id=p.id ORDER BY created_at DESC,id DESC LIMIT 1)d ON true WHERE p.tenant_id=$1 AND p.calculation_id=$2 ORDER BY p.version DESC',[context.id,calculationId])).rows};
  });
 }
 async prepare(context,calculationId,input){
  if(!validTenantId(calculationId)||!validTenantId(input?.id)||input.completeDocumentsConfirmed!==true||input.priceFieldConfirmed!==true||!Array.isArray(input.fileIds)||input.fileIds.length>30)throw fail('offer_package_explicit_review_required');
  const requestHash=snapshotHash({calculationId,files:input.fileIds,price:input.priceBinding,completeDocumentsConfirmed:true,priceFieldConfirmed:true});
  return withTenantContext(this.pool,context,async db=>{
   const {calculation,decision,review}=await this.context(db,context,calculationId);
   const existing=(await db.query('SELECT * FROM tenant_portal.offer_packages WHERE tenant_id=$1 AND id=$2',[context.id,input.id])).rows[0];if(existing){if(existing.request_sha256!==requestHash)throw fail('offer_package_request_conflict',409);return existing;}
   const files=await this.documents.files(db,context.id,input.fileIds,{parse:true});
   const required=review.requirements.filter(x=>x.status==='VALIDATED').map(x=>x.evidenceFileId);
   if(required.some(id=>!input.fileIds.includes(id)))throw fail('offer_package_required_evidence_missing');
   const priceFile=files.find(x=>x.id===input.priceBinding?.fileId);if(!priceFile)throw fail('offer_package_price_file_required');
   const price=verifyOfferPrice(priceFile,input.priceBinding,calculation.result.totalPrice);
   const version=Number((await db.query('SELECT coalesce(max(version),0)+1 version FROM tenant_portal.offer_packages WHERE tenant_id=$1 AND calculation_id=$2',[context.id,calculationId])).rows[0].version);
   const manifest={version:1,scope:'INTERNAL_OFFER_PACKAGE',tenantId:context.id,companyId:calculation.company_id,workspaceId:calculation.workspace_id,lotKey:calculation.lot_key,sourceVersionId:calculation.source_version_id,assignmentId:calculation.assignment_id,calculationId,calculationHash:calculation.result.calculationHash,calculationApprovalId:decision.id,documentReviewId:review.id,documentReviewHash:review.snapshot_sha256,requirements:review.requirements,price,files:files.map(({id,filename,sha256})=>({id,filename,sha256})),completeDocumentsConfirmed:true,externalTransmission:false};
   const row=(await db.query('INSERT INTO tenant_portal.offer_packages(id,tenant_id,calculation_id,document_review_id,version,manifest,manifest_sha256,request_sha256,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[input.id,context.id,calculationId,review.id,version,manifest,snapshotHash(manifest),requestHash,context.actorUserId])).rows[0];
   for(const file of files)await db.query('INSERT INTO tenant_portal.offer_package_files(tenant_id,package_id,file_id) VALUES($1,$2,$3)',[context.id,row.id,file.id]);
   await this.audit(db,context,'OFFER_PACKAGE_PREPARED',row.id,{manifestHash:row.manifest_sha256});return row;
  });
 }
 async current(db,context,id){
  const row=(await db.query('SELECT * FROM tenant_portal.offer_packages WHERE tenant_id=$1 AND id=$2',[context.id,id])).rows[0];if(!row)throw fail('offer_package_not_found',404);
  const {decision,review}=await this.context(db,context,row.calculation_id);
  const latest=(await db.query('SELECT id FROM tenant_portal.offer_packages WHERE tenant_id=$1 AND calculation_id=$2 ORDER BY version DESC LIMIT 1',[context.id,row.calculation_id])).rows[0];
  if(latest.id!==id||snapshotHash(row.manifest)!==row.manifest_sha256||row.manifest.documentReviewId!==review.id||row.manifest.documentReviewHash!==review.snapshot_sha256||row.manifest.calculationApprovalId!==decision.id)throw fail('offer_package_version_changed',409);
  const files=await this.documents.files(db,context.id,row.manifest.files.map(x=>x.id));
  if(files.some(file=>!row.manifest.files.some(x=>x.id===file.id&&x.sha256===file.sha256)))throw fail('offer_package_file_integrity_failed',409);
  return row;
 }
 async decide(context,id,input){
  if(!validTenantId(id)||!validTenantId(input?.id)||!['APPROVED','REJECTED'].includes(input.decision)||input.confirmed!==true||typeof input.reason!=='string'||input.reason.trim().length<10||input.reason.length>1000)throw fail('offer_package_decision_invalid');
  const requestHash=snapshotHash({packageId:id,decision:input.decision,reason:input.reason.trim(),actor:context.actorUserId});
  return withTenantContext(this.pool,context,async db=>{
   const row=await this.current(db,context,id);
   const existing=(await db.query('SELECT * FROM tenant_portal.offer_package_decisions WHERE tenant_id=$1 AND id=$2',[context.id,input.id])).rows[0];if(existing){if(existing.request_sha256!==requestHash)throw fail('offer_package_request_conflict',409);return existing;}
   const decision=(await db.query('INSERT INTO tenant_portal.offer_package_decisions(id,tenant_id,package_id,decision,reason,manifest_sha256,request_sha256,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[input.id,context.id,id,input.decision,input.reason.trim(),row.manifest_sha256,requestHash,context.actorUserId])).rows[0];
   await this.audit(db,context,'OFFER_PACKAGE_'+input.decision,id,{decisionId:decision.id,manifestHash:row.manifest_sha256});return decision;
  });
 }
 async download(context,id){
  if(!validTenantId(id))throw fail('offer_package_not_found',404);
  return withTenantContext(this.pool,context,async db=>{
   const row=await this.current(db,context,id);
   const decision=(await db.query('SELECT * FROM tenant_portal.offer_package_decisions WHERE tenant_id=$1 AND package_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[context.id,id])).rows[0];
   if(decision?.decision!=='APPROVED'||decision.manifest_sha256!==row.manifest_sha256)throw fail('offer_package_management_approval_required',409);
   const files=[];for(const file of row.manifest.files)files.push({...file,buffer:await this.storage.get(context.id,file.id)});
   const bytes=await offerPackageZip({...row.manifest,packageId:id,packageVersion:row.version,manifestHash:row.manifest_sha256,managementDecisionId:decision.id},files);
   await this.audit(db,context,'OFFER_PACKAGE_DOWNLOADED',id,{sha256:digest(bytes),externalTransmission:false});return bytes;
  });
 }
 async audit(db,context,action,id,metadata){await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,'offer_package',$4,$5)",[context.id,context.actorUserId,action,id,metadata]);}
}
