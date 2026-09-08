import {chromium} from 'playwright';
import {readFileSync} from 'node:fs';
import {authenticatePortalWithBrowser} from './semantic-browser-auth.mjs';
import {bytesHash,requireDispatch,dispatchError,assertDispatchDocuments} from './submission-dispatch-core.mjs';
import {canonicalJson,liveSubmissionHash} from './submission-live-core.mjs';

export const SUBMISSION_BROWSER_CODE_SHA256=bytesHash(readFileSync(new URL(import.meta.url)));
const readOnlySources=new Set(['ted','ted-discovery','datenservice-oeffentlicher-einkauf']);
export function submissionLoginFailure(resultCode){
 if(resultCode==='PORTAL_NICHT_ERREICHBAR')return dispatchError('submission_network_unavailable');
 if(/FORMULAR|REDIRECT/.test(resultCode||''))return dispatchError('submission_portal_changed');
 if(/MFA|CAPTCHA/.test(resultCode||''))return dispatchError('submission_portal_interaction_required');
 if(['BENUTZERNAME_ODER_PASSWORT_FALSCH','KONTO_GESPERRT','PASSWORT_ABGELAUFEN'].includes(resultCode))return dispatchError('submission_credentials_required');
 return dispatchError('submission_login_not_verified');
}
export function validateSubmissionProfile(profile,binding,{isolatedTest=false}={}){
 requireDispatch(profile?.kind==='WB_BROWSER_SUBMISSION_PROFILE_V1','submission_portal_changed');
 requireDispatch(profile.host===binding.portalHost&&profile.adapterId===binding.portalAdapterId&&profile.adapterVersion===binding.portalAdapterVersion,'submission_portal_binding_invalid');
 requireDispatch(!readOnlySources.has(profile.adapterId),'submission_publication_source_is_not_submission_portal');
 requireDispatch(isolatedTest||profile.codeSha256===SUBMISSION_BROWSER_CODE_SHA256,'submission_adapter_not_validated');
 requireDispatch(profile.existingReceiptSelector&&profile.target?.tender?.selector&&profile.target?.lot?.selector&&profile.upload?.inputSelector&&profile.upload?.rowsSelector&&profile.upload?.filenameSelector&&profile.upload?.downloadSelector&&profile.submit?.selector&&profile.submit?.text&&profile.receipt?.reference?.selector&&profile.receipt?.timestamp?.selector&&profile.receipt?.tender?.selector&&profile.receipt?.lot?.selector,'submission_portal_changed');
 requireDispatch(Array.isArray(profile.requests)&&profile.requests.some(r=>r.phase==='COMMIT'),'submission_portal_changed');
 for(const r of profile.requests){
  requireDispatch(['NAVIGATE','UPLOAD','FIELDS','COMMIT'].includes(r.phase)&&['POST','PUT','PATCH'].includes(r.method)&&typeof r.path==='string'&&r.path.startsWith('/')&&!r.path.includes('?'),'submission_portal_changed');
  if(profile.requests.some(other=>other!==r&&other.method===r.method&&other.path===r.path&&other.phase!==r.phase))requireDispatch(r.formField&&typeof r.formValue==='string'&&!profile.requests.some(other=>other!==r&&other.method===r.method&&other.path===r.path&&other.phase!==r.phase&&(other.formField!==r.formField||other.formValue===r.formValue)),'submission_portal_changed');
 }
 return profile;
}
export function submissionRequestAllowed(request,{binding,profile,phase}){
 let url;try{url=new URL(request.url)}catch{return false}
 if(url.protocol!=='https:'||url.hostname!==binding.portalHost||url.username||url.password||(url.port&&url.port!=='443'))return false;
 if([...url.searchParams.keys()].some(k=>/password|secret|token|cookie|authorization/i.test(k)))return false;
 if(['GET','HEAD'].includes(request.method))return !profile.requests.some(rule=>rule.path===url.pathname);
 return profile.requests.some(rule=>rule.phase===phase&&rule.method===request.method&&rule.path===url.pathname&&(!rule.formField||new URLSearchParams(request.body||'').get(rule.formField)===rule.formValue));
}
const fieldValue=(binding,path)=>String(path).split('.').reduce((value,key)=>['__proto__','constructor','prototype'].includes(key)?undefined:value?.[key],binding);
export class BrowserSubmissionAdapter{
 constructor({binding,profile,portal,authenticate=authenticatePortalWithBrowser,launch=options=>chromium.launch(options),isolatedTest=false,setupContext=null}){
  requireDispatch(!isolatedTest||process.env.NODE_ENV==='test','submission_test_mode_forbidden');
  requireDispatch(!setupContext||isolatedTest,'submission_test_mode_forbidden');
  this.binding=binding;this.profile=validateSubmissionProfile(profile,binding,{isolatedTest});this.portal=portal;this.authenticate=authenticate;this.launch=launch;this.setupContext=setupContext;this.phase='READ_ONLY';this.blocked=false;this.commitRequests=0;
 }
 async exact(spec,expected){
  requireDispatch(spec?.selector,'submission_portal_changed');const locator=this.page.locator(spec.selector);
  requireDispatch(await locator.count()===1,'submission_portal_changed');
  const value=spec.attribute?await locator.getAttribute(spec.attribute):await locator.textContent();
  requireDispatch(typeof value==='string'&&value.trim().length>0,'submission_portal_changed');
  if(expected!==undefined)requireDispatch(value.trim()===String(expected),'submission_portal_binding_invalid');
  return value.trim();
 }
 async target(receipt=false){const target=receipt?this.profile.receipt:this.profile.target;await this.exact(target.tender,this.binding.portalTenderReference);await this.exact(target.lot,this.binding.lotKey);requireDispatch(new URL(this.page.url()).hostname===this.binding.portalHost,'submission_portal_binding_invalid');}
 async click(spec){await this.fence();await this.exact({selector:spec.selector},spec.text);const control=this.page.locator(spec.selector);requireDispatch(await control.isVisible()&&await control.isEnabled(),'submission_portal_changed');await control.click({timeout:15000});requireDispatch(!this.blocked,'submission_portal_changed');}
 async download(url){
  requireDispatch(submissionRequestAllowed({url,method:'GET'},{binding:this.binding,profile:this.profile,phase:this.phase}),'submission_portal_binding_invalid');
  const response=await this.context.request.get(url,{maxRedirects:0,timeout:30000});requireDispatch(response.ok(),'submission_upload_interrupted');
  const bytes=await response.body();requireDispatch(bytes.length<=20*1024*1024,'submission_receipt_bytes_required');return bytes;
 }
 async uploadedDocuments({complete=false}={}){
  const rows=this.page.locator(this.profile.upload.rowsSelector);const found=[];
  for(let i=0;i<await rows.count();i++){
   const row=rows.nth(i),names=row.locator(this.profile.upload.filenameSelector),links=row.locator(this.profile.upload.downloadSelector);
   requireDispatch(await names.count()===1&&await links.count()===1,'submission_portal_changed');
   const name=(await names.textContent()).trim(),expected=this.binding.documents.find(d=>d.filename===name);
   requireDispatch(expected&&!found.includes(expected.id),'submission_unexpected_remote_document');
   const url=new URL(await links.getAttribute('href'),this.page.url()).href,bytes=await this.download(url);
   requireDispatch(bytes.length===expected.sizeBytes&&bytesHash(bytes)===expected.sha256,'submission_remote_document_mismatch');found.push(expected.id);
  }
  if(complete)requireDispatch(found.length===this.binding.documents.length,'submission_document_manifest_changed');return found;
 }
 async prepare({credential,documents,fence,onEvidence=async()=>{}}){
  this.fence=fence;assertDispatchDocuments(this.binding,documents);await fence();
  const login=await this.authenticate({portal:this.portal,credential,targetUrl:this.binding.portalTenderUrl,timeoutMs:60000});
  if(login.resultCode!=='LOGIN_ERFOLGREICH')throw submissionLoginFailure(login.resultCode);
  requireDispatch(login.documentAccess&&login.session?.storageState,'submission_credentials_required');
  this.browser=await this.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE_PATH||'/usr/bin/chromium-browser',args:['--disable-dev-shm-usage','--no-sandbox']});
  this.context=await this.browser.newContext({acceptDownloads:true,serviceWorkers:'block',storageState:login.session.storageState});
  await this.setupContext?.(this.context);
  await this.context.route('**/*',async route=>{
   const req=route.request(),url=req.url();let allowed=submissionRequestAllowed({url,method:req.method(),body:req.postData()},{binding:this.binding,profile:this.profile,phase:this.phase});
   if([credential.username,credential.password].some(secret=>secret&&url.includes(secret)))allowed=false;
   if(allowed&&!['GET','HEAD'].includes(req.method()))try{await this.fence()}catch{allowed=false;}
   if(allowed&&this.phase==='COMMIT'&&!['GET','HEAD'].includes(req.method())){this.commitRequests++;if(this.commitRequests>1)allowed=false;}
   if(!allowed){this.blocked=true;return route.abort('blockedbyclient');}return route.fallback();
  });
  if(login.session.sessionStorage)await this.context.addInitScript(sessions=>{const state=Array.isArray(sessions)?sessions.find(item=>item.origin===location.origin):null;if(state)for(const [key,value]of state.entries||[])sessionStorage.setItem(key,String(value));},login.session.sessionStorage);
  this.page=await this.context.newPage();this.page.setDefaultTimeout(15000);
  await this.page.goto(this.binding.portalTenderUrl,{waitUntil:'domcontentloaded',timeout:30000});await this.target();
  this.phase='NAVIGATE';for(const action of this.profile.openSubmission||[])await this.click(action);
  await this.target();
  if(this.profile.existingReceiptSelector)requireDispatch(await this.page.locator(this.profile.existingReceiptSelector).count()===0,'submission_prior_remote_receipt_requires_reconciliation');
  this.phase='UPLOAD';
  const present=await this.uploadedDocuments();
  for(const document of documents){
   if(!present.includes(document.id)){
    await this.fence();await this.target();const input=this.page.locator(this.profile.upload.inputSelector);requireDispatch(await input.count()===1,'submission_portal_changed');
    await input.setInputFiles({name:document.filename,mimeType:document.mediaType||'application/octet-stream',buffer:document.buffer});
    if(this.profile.upload.button)await this.click(this.profile.upload.button);
    await this.page.locator(this.profile.upload.rowsSelector).filter({hasText:document.filename}).waitFor({state:'visible',timeout:30000});
   }
   await this.uploadedDocuments();await onEvidence('UPLOAD_VERIFIED',{documentId:document.id,sha256:document.sha256,sizeBytes:document.sizeBytes});
  }
  this.phase='FIELDS';
  for(const field of this.profile.fields||[]){
   await this.fence();const value=fieldValue(this.binding,field.valuePath);requireDispatch(['string','number','boolean'].includes(typeof value),'submission_approved_field_required');
   const input=this.page.locator(field.selector);requireDispatch(await input.count()===1,'submission_portal_changed');
   if(field.type==='checkbox'){requireDispatch(typeof value==='boolean','submission_approved_field_required');await input.setChecked(value);}
   else if(field.type==='select')await input.selectOption(String(value));else await input.fill(String(value));
  }
  if(this.profile.preflightButton)await this.click(this.profile.preflightButton);
  requireDispatch(await this.page.locator('input:invalid,select:invalid,textarea:invalid').count()===0,'submission_required_portal_fields_missing');
  await this.target();await this.uploadedDocuments({complete:true});requireDispatch(!this.blocked,'submission_portal_changed');
  await this.exact({selector:this.profile.submit.selector},this.profile.submit.text);
  return {prepared:true};
 }
 async submit({beforeCommit,fence}){
  await this.target();await this.uploadedDocuments({complete:true});await beforeCommit();
  this.fence=fence;this.phase='COMMIT';await this.click(this.profile.submit);
  await this.page.locator(this.profile.receipt.reference.selector).waitFor({state:'visible',timeout:45000});return this.reconcileCurrentPage();
 }
 async reconcileCurrentPage(){
  this.phase='READ_ONLY';requireDispatch(this.commitRequests===1,'submission_finalization_not_observed');requireDispatch(this.page&&!this.page.isClosed(),'submission_receipt_missing');await this.target(true);
  const reference=await this.exact(this.profile.receipt.reference),submittedAt=await this.exact(this.profile.receipt.timestamp);
  let bytes,mediaType;
  if(this.profile.receipt.downloadSelector){const link=this.page.locator(this.profile.receipt.downloadSelector);requireDispatch(await link.count()===1,'submission_receipt_missing');bytes=await this.download(new URL(await link.getAttribute('href'),this.page.url()).href);mediaType='application/pdf';}
  else{bytes=Buffer.from(canonicalJson({source:'PORTAL_DOM',reference,submittedAt,tenderReference:await this.exact(this.profile.receipt.tender),lotKey:await this.exact(this.profile.receipt.lot)}));mediaType='application/json';}
  return {verified:true,reference,submittedAt,portalHost:new URL(this.page.url()).hostname,tenderReference:await this.exact(this.profile.receipt.tender),lotKey:await this.exact(this.profile.receipt.lot),packageSha256:this.binding.packageSha256,documents:this.binding.documents,bytes,mediaType};
 }
 async close(){await this.context?.close().catch(()=>{});await this.browser?.close().catch(()=>{});}
}
export async function loadReleasedSubmissionAdapter(db,row,dependencies={}){
 const release=(await db.query('SELECT * FROM tender.submission_adapter_releases WHERE portal_id=$1',[row.portal_id])).rows[0];
 requireDispatch(release?.enabled===true&&release.validation_status==='PRODUCTION_VALIDATED'&&liveSubmissionHash(release.profile)===release.profile_sha256,'submission_adapter_not_validated');
 requireDispatch(['login','target','upload','finalization','receipt','nonBindingTest'].every(key=>release.validation_evidence?.[key]===true),'submission_adapter_not_validated');
 const portal=(await db.query('SELECT * FROM tender.portal_registry WHERE id=$1',[row.portal_id])).rows[0];
 return new BrowserSubmissionAdapter({binding:row.binding,profile:release.profile,portal,...dependencies});
}
