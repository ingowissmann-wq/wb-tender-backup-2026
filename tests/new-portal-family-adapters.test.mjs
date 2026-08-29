import assert from "node:assert/strict";
import test from "node:test";
import {adapterFor,runPortalReadLifecycle,validatePortalAdapterContract} from "../platform/portal-connector-platform.mjs";
import {submissionAdapterFor} from "../platform/submission-adapters.mjs";

const profiles=[
  {adapter_id:"eu-funding-tenders",adapter_version:"2.0.0",canonical_domain:"ec.europa.eu",authentication_domains:["ecas.ec.europa.eu"],download_domains:["ec.europa.eu","webgate.ec.europa.eu"],capabilities:["LOGIN_SSO","MFA_POSSIBLE","JAVASCRIPT_REQUIRED","DIRECT_TENDER_LINK_SUPPORTED","DOCUMENT_LIST_SUPPORTED","DIRECT_DOWNLOAD_SUPPORTED","PUBLIC_DOCUMENTS_POSSIBLE","AUTHENTICATED_DOCUMENTS_REQUIRED"],login_strategy:"EU_LOGIN_SSO",enabled:true,validation_status:"VALIDATED"},
  {adapter_id:"etenders-ireland",adapter_version:"2.0.0",canonical_domain:"www.etenders.gov.ie",authentication_domains:["www.etenders.gov.ie"],download_domains:["www.etenders.gov.ie"],capabilities:["LOGIN_BROWSER_REQUIRED","CSRF_REQUIRED","JAVASCRIPT_REQUIRED","MFA_POSSIBLE","CAPTCHA_POSSIBLE","DIRECT_TENDER_LINK_SUPPORTED","DOCUMENT_LIST_SUPPORTED","DIRECT_DOWNLOAD_SUPPORTED","PUBLIC_DOCUMENTS_POSSIBLE","AUTHENTICATED_DOCUMENTS_REQUIRED"],login_strategy:"CAS_BROWSER",enabled:true,validation_status:"VALIDATED"},
];
for(const profile of profiles)test(`${profile.adapter_id} passes full read contract and inert submission simulation`,async()=>{
  const adapter=adapterFor(profile);assert.equal(validatePortalAdapterContract(adapter).valid,true);
  const result=await runPortalReadLifecycle(adapter,{url:`https://${profile.canonical_domain}/tender/AUTH-1`,externalId:"AUTH-1",snapshot:{publicAccess:true,tender:{id:"AUTH-1",lots:["LOT-1"]},documents:[{id:"D1",name:"specification.pdf",url:`https://${profile.download_domains[0]}/documents/specification.pdf`}]}});
  assert.equal(result.status,"DOCUMENT_TREE_EXPANDED");assert.equal(result.documents.length,1);
  const submission=submissionAdapterFor(profile.adapter_id),pkg=await submission.buildInternalPackage({scope:{tenderId:"T1",companyId:"C1",lotKey:"LOT-1",portalId:"P1"},documents:[{id:"D1",category:"SPECIFICATION",filename:"offer.pdf",sha256:"a".repeat(64),sizeBytes:42}]});
  const simulated=await submission.simulateSubmission({package:pkg,confirmation:"SIMULATION_ONLY",deadlineOpen:true,requiredDocumentsComplete:true,packageHashApproved:true,allowExternalWrite:false});
  assert.equal(simulated.status,"SIMULATED_RECEIPT_VERIFIED");assert.equal(simulated.transmitted,false);
  await assert.rejects(()=>submission.submit({}),error=>error.code==="AUTOPILOT_SUBMISSION_NOT_IMPLEMENTED");
});
test("EU Login MFA and eTenders CAPTCHA remain explicit human continuations",async()=>{
  const eu=await runPortalReadLifecycle(adapterFor(profiles[0]),{url:"https://ec.europa.eu/info/funding-tenders/opportunities/portal/",credential:{username:"masked",password:"not-logged"},snapshot:{loginRequired:true,credentialOutcome:"SUCCESS",mfaRequired:true}});assert.equal(eu.status,"MFA_REQUIRED");
  const ie=adapterFor(profiles[1]);assert.equal(await ie.detectCaptcha({}, {snapshot:{captchaRequired:true}}),true);
});
