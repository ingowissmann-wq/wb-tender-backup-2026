import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './submission-dispatch-fixture.mjs';
import {BrowserSubmissionAdapter,submissionRequestAllowed,validateSubmissionProfile,submissionLoginFailure} from '../platform/submission-browser-adapter.mjs';
import {dispatchFailure} from '../platform/submission-dispatch-core.mjs';
import Fastify from 'fastify';
import {chromium} from 'playwright';
import {registerSubmissionCredentialRecovery} from '../platform/submission-credential-recovery.mjs';
import {verifyDispatchReceipt} from '../platform/submission-dispatch-core.mjs';
process.env.NODE_ENV='test';
test('embedded secure reentry renders only the selected company and clears submitted password',async()=>{
 const app=Fastify();registerSubmissionCredentialRecovery(app,{pool:{},requirePermission:()=>async()=>{},csrf:async()=>{},isFreshWbMfa:async()=>true});
 const script=(await app.inject('/submission-credential-recovery.js')).body;await app.close();
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE_PATH||'/usr/bin/chromium-browser',args:['--no-sandbox']});
 let saved=false;
 try{
  const context=await browser.newContext();await context.addCookies([{name:'wb_csrf',value:'fixture-csrf',url:'https://sandbox.invalid'}]);
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());assert.equal(url.hostname,'sandbox.invalid');
   if(url.pathname==='/submission-credential-recovery.js')return route.fulfill({contentType:'text/javascript',body:script});
   if(url.pathname==='/api/submission/credential-recovery')return route.fulfill({json:{items:saved?[]:[{id:'credential-a',companyId:'company-a',portalName:'Portal A',status:'CREDENTIALS_REQUIRED',message:'Erneute Eingabe erforderlich'},{id:'credential-b',companyId:'company-b',portalName:'Portal B',status:'CREDENTIALS_REQUIRED'}]}});
   if(request.method()==='POST'){
    assert.equal(url.pathname,'/api/submission/credential-recovery/credential-a');assert.equal(request.headers()['x-csrf-token'],'fixture-csrf');
    assert.deepEqual(request.postDataJSON(),{companyId:'company-a',username:'fixture-user',password:'fixture-password'});saved=true;
    return route.fulfill({json:{status:'SECURE_REENTRY_SAVED'}});
   }
   return route.fulfill({contentType:'text/html',body:`<section id="recovery"><p data-recovery-status></p><div data-recovery-items></div></section><script type="module">import {mountCredentialRecovery} from '/submission-credential-recovery.js';mountCredentialRecovery(document.querySelector('#recovery'),{companyId:'company-a'});</script>`});
  });
  const page=await context.newPage();await page.goto('https://sandbox.invalid/admin/ausschreibungen/autopilot/portal-access');
  await page.getByRole('heading',{name:'Portal A'}).waitFor();assert.equal(await page.getByText('Portal B').count(),0);
  assert.match(await page.locator('#recovery').textContent(),/CREDENTIALS_REQUIRED/);
  await page.getByLabel('Benutzername').fill('fixture-user');await page.getByLabel('Passwort').fill('fixture-password');await page.getByRole('button').click();
  await page.getByText('Zugang verschlüsselt gespeichert und erfolgreich zurückgelesen.').waitFor();
  assert.equal(saved,true);assert.equal(await page.locator('input[type=password]').count(),0);
 }finally{await browser.close()}
});
test('portal outage retries before intent without requesting a new password',()=>{
 const deadlineAt=new Date(Date.now()+3600000).toISOString();
 const error=submissionLoginFailure('PORTAL_NICHT_ERREICHBAR');
 assert.equal(dispatchFailure(error,{deadlineAt,attempt:1}).status,'RETRY_REQUIRED');
 assert.equal(dispatchFailure(error,{deadlineAt,commitStarted:true}).status,'MANUAL_INTERVENTION_REQUIRED');
 assert.equal(dispatchFailure(submissionLoginFailure('BENUTZERNAME_ODER_PASSWORT_FALSCH'),{deadlineAt}).status,'CREDENTIALS_REQUIRED');
 assert.equal(dispatchFailure(submissionLoginFailure('DOKUMENTENBERECHTIGUNG_FEHLT'),{deadlineAt}).status,'MANUAL_INTERVENTION_REQUIRED');
});
test('unverified login never starts the submission browser',async()=>{
 const {binding,documents}=fixture();let launched=false;
 const adapter=new BrowserSubmissionAdapter({binding,profile:profile(binding),portal:{},isolatedTest:true,authenticate:async()=>({resultCode:'PORTAL_NICHT_ERREICHBAR'}),launch:async()=>{launched=true;throw new Error('unexpected launch')}});
 await assert.rejects(adapter.prepare({credential:{},documents,fence:async()=>{}}),/submission_network_unavailable/);
 assert.equal(launched,false);
});
function profile(b){return{kind:'WB_BROWSER_SUBMISSION_PROFILE_V1',host:b.portalHost,adapterId:b.portalAdapterId,adapterVersion:b.portalAdapterVersion,existingReceiptSelector:'#reference',target:{tender:{selector:'#tender'},lot:{selector:'#lot'}},upload:{inputSelector:'#upload',rowsSelector:'.uploaded',filenameSelector:'.name',downloadSelector:'a'},submit:{selector:'#submit',text:'Nicht bindendes Testangebot abgeben'},receipt:{reference:{selector:'#reference'},timestamp:{selector:'#timestamp'},tender:{selector:'#receipt-tender'},lot:{selector:'#receipt-lot'}},requests:[{phase:'UPLOAD',method:'POST',path:'/upload'},{phase:'COMMIT',method:'POST',path:'/submit'}]};}
test('finalization request cannot escape phase or portal boundary',()=>{const {binding:b}=fixture(),p=profile(b);assert.equal(submissionRequestAllowed({url:'https://'+b.portalHost+'/submit',method:'POST'},{binding:b,profile:p,phase:'UPLOAD'}),false);assert.equal(submissionRequestAllowed({url:'https://foreign.invalid/submit',method:'POST'},{binding:b,profile:p,phase:'COMMIT'}),false);assert.equal(submissionRequestAllowed({url:'https://'+b.portalHost+'/submit',method:'POST'},{binding:b,profile:p,phase:'COMMIT'}),true)});
test('overlapping form actions require disjoint action values',()=>{const {binding:b}=fixture(),p=profile(b);p.requests=[{phase:'UPLOAD',method:'POST',path:'/action',formField:'action',formValue:'send'},{phase:'COMMIT',method:'POST',path:'/action',formField:'action',formValue:'send'}];assert.throws(()=>validateSubmissionProfile(p,b,{isolatedTest:true}),/portal_changed/)});
for(const changedLot of [false,true])test('isolated Chromium upload and receipt, wrong lot='+changedLot,async()=>{
 const {binding:b,documents}=fixture(),p=profile(b),uploaded=new Map();let finalizations=0,intent=false;
 const adapter=new BrowserSubmissionAdapter({binding:b,profile:p,portal:{},isolatedTest:true,authenticate:async()=>({resultCode:'LOGIN_ERFOLGREICH',documentAccess:true,session:{storageState:{cookies:[],origins:[]},sessionStorage:[]}}),setupContext:async context=>{
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());
   if(url.pathname==='/upload'){assert.equal(request.method(),'POST');const body=request.postDataBuffer();assert.ok(body.includes(documents[0].buffer));uploaded.set(documents[0].filename,documents[0].buffer);return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({filename:documents[0].filename})})}
   if(url.pathname==='/submit'){assert.equal(intent,true);assert.equal(uploaded.size,1);finalizations++;return route.fulfill({status:200,contentType:'text/html',body:`<span id="reference">NON-BINDING-RECEIPT</span><span id="timestamp">${new Date().toISOString()}</span><span id="receipt-tender">${b.portalTenderReference}</span><span id="receipt-lot">${b.lotKey}</span>`})}
   return route.fulfill({status:200,contentType:'text/html',body:`<!doctype html><span id="tender">${b.portalTenderReference}</span><span id="lot">${changedLot?'WRONG-LOT':b.lotKey}</span><input id="upload" type="file"><section id="files"></section><button id="submit">Nicht bindendes Testangebot abgeben</button><script>document.querySelector('#upload').onchange=async e=>{const data=new FormData();data.append('file',e.target.files[0]);const r=await fetch('/upload',{method:'POST',body:data});const d=await r.json();const row=document.createElement('div');row.className='uploaded';const name=document.createElement('span');name.className='name';name.textContent=d.filename;const link=document.createElement('a');link.href='/download/'+encodeURIComponent(d.filename);link.textContent='Download';row.append(name,link);document.querySelector('#files').append(row)};document.querySelector('#submit').onclick=async()=>{const r=await fetch('/submit',{method:'POST',body:'nonbinding=true'});document.body.innerHTML=await r.text()};</script>`});
  });
 }});
 // Test-only download provider reads bytes uploaded through the real browser form.
 adapter.download=async url=>{const name=decodeURIComponent(new URL(url).pathname.split('/').at(-1));assert.ok(uploaded.has(name));return uploaded.get(name)};
 try{
  if(changedLot){await assert.rejects(adapter.prepare({credential:{username:'test-account',password:'test-password'},documents,fence:async()=>{}}),/portal_binding_invalid/);assert.equal(finalizations,0);assert.equal(uploaded.size,0)}
  else{await adapter.prepare({credential:{username:'test-account',password:'test-password'},documents,fence:async()=>{}});assert.equal(finalizations,0);const result=await adapter.submit({beforeCommit:async()=>{intent=true},fence:async()=>{assert.equal(intent,true)}});assert.equal(finalizations,1);assert.equal(verifyDispatchReceipt(b,result).reference,'NON-BINDING-RECEIPT')}
 }finally{await adapter.close()}
});
