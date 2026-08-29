import assert from "node:assert/strict";
import test from "node:test";
import {ProtocolReplayConnector,runPortalReadLifecycle,validatePortalAdapterContract} from "../platform/portal-connector-platform.mjs";
import {submissionAdapterFor} from "../platform/submission-adapters.mjs";
import {FAMILY_ADAPTER_CAPABILITIES,FAMILY_INTERNAL_REPLAY_EVIDENCE} from "../platform/portal-readiness-dimensions.mjs";

const families={
  "ai-vergabe-manager":"vergabe.muenchen.de","aumass":"plattform.aumass.de","bi-medien":"bi-medien.de",
  "cosinex":"www.evergabe.nrw.de","deutsche-evergabe":"www.deutsche-evergabe.de","dtvp":"www.dtvp.de",
  "etenders-ireland":"www.etenders.gov.ie","eu-funding-tenders":"ec.europa.eu","evergabe-bayern":"www.evergabe.bayern.de",
  "evergabe-de":"www.evergabe.de","evergabe-online-bund":"www.evergabe-online.de","mercell-s2c":"s2c.mercell.com",
  "rib-meinauftrag":"www.meinauftrag.rib.de","subreport":"www.subreport-elvis.de","ted":"ted.europa.eu","vergabe24":"www.vergabe24.de",
};

test("all 16 production-relevant families pass read, MFA/CAPTCHA-safe and non-transmitting submission contracts",async()=>{
  assert.deepEqual(Object.keys(FAMILY_INTERNAL_REPLAY_EVIDENCE).sort(),Object.keys(families).sort());
  assert.equal(FAMILY_ADAPTER_CAPABILITIES.length,14);
  for(const [familyKey,domain] of Object.entries(families)){
    const profile={adapter_id:familyKey,adapter_version:"2.0.0",canonical_domain:domain,authentication_domains:[domain],download_domains:[domain],capabilities:["LOGIN_BROWSER_REQUIRED","MFA_POSSIBLE","CAPTCHA_POSSIBLE","DIRECT_TENDER_LINK_SUPPORTED","DOCUMENT_LIST_SUPPORTED","DIRECT_DOWNLOAD_SUPPORTED","PUBLIC_DOCUMENTS_POSSIBLE","AUTHENTICATED_DOCUMENTS_REQUIRED"],login_strategy:"PROTOCOL_REPLAY",enabled:true,validation_status:"VALIDATED"};
    const adapter=new ProtocolReplayConnector(profile);assert.equal(validatePortalAdapterContract(adapter).operations.length>10,true);
    const read=await runPortalReadLifecycle(adapter,{url:`https://${domain}/tender/AUTH-1`,snapshot:{publicAccess:true,tender:{id:"AUTH-1",lots:["LOT-1"]},documents:[{id:"D1",name:"documents.zip",url:`https://${domain}/documents/D1`}]}});assert.equal(read.status,"DOCUMENT_TREE_EXPANDED",familyKey);
    const submission=submissionAdapterFor(familyKey),pkg=await submission.buildInternalPackage({scope:{tenderId:"T1",companyId:"C1",lotKey:"LOT-1",portalId:"P1"},documents:[{id:"D1",category:"OFFER",filename:"offer.pdf",sha256:"b".repeat(64),sizeBytes:100}]});
    const simulated=await submission.simulateSubmission({package:pkg,confirmation:"SIMULATION_ONLY",deadlineOpen:true,requiredDocumentsComplete:true,packageHashApproved:true,allowExternalWrite:false});assert.equal(simulated.status,"SIMULATED_RECEIPT_VERIFIED",familyKey);assert.equal(simulated.transmitted,false);
    await assert.rejects(()=>submission.submit({}),error=>error.code==="AUTOPILOT_SUBMISSION_NOT_IMPLEMENTED");
  }
});
