import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateEnterprisePreflight, finalSubmissionGate, submissionFingerprint,
} from "../platform/submission-framework.mjs";
import {
  acceptanceSandboxAdapter, advanceSubmissionState, canonicalPackageManifest,
  normalizeInboundEvent, reconcilePortalHistory, runReconciliationJob,
  verifyPackageManifest,
} from "../platform/submission-orchestrator.mjs";
import { submissionAdapters } from "../platform/submission-adapters.mjs";

const scope={tenderId:"11111111-1111-4111-8111-111111111111",companyId:"22222222-2222-4222-8222-222222222222",lotKey:"LOT-1",portalId:"33333333-3333-4333-8333-333333333333",credentialId:"44444444-4444-4444-8444-444444444444"};
const hash="a".repeat(64);

test("immutable package manifest detects tampering and preserves exact scope",()=>{
  const manifest=canonicalPackageManifest({scope,approval:{id:"approval-1",payloadSha256:hash,approvedVersion:3},documents:[{id:"doc-1",category:"PRICE",filename:"preis.pdf",mediaType:"application/pdf",sizeBytes:123,sha256:hash,version:2}],createdAt:"2026-08-22T00:00:00Z"});
  assert.equal(verifyPackageManifest(manifest),true);
  assert.deepEqual(manifest.scope,scope);
  assert.equal(verifyPackageManifest({...manifest,documents:[{...manifest.documents[0],filename:"other.pdf"}]}),false);
});

test("preflight, final approval and duplicate protection remain separate fail-closed gates",()=>{
  const complete={managementApprovalValid:true,bidPackageReady:true,portalSupportsSubmission:true,autopilotSupportsSubmission:true,portalAccountPresent:true,credentialsPresent:true,credentialsSubmissionCapable:true,portalSessionValid:true,mfaComplete:true,targetResolved:true,deadlineOpen:true,packageMapped:true,requiredDocumentsComplete:true,formatsAccepted:true,sizesAccepted:true,requiredFieldsComplete:true,signatureRequirementKnown:true,signatureRequired:false,amendmentsChecked:true,versionBindingValid:true,portalValidationPassed:true};
  assert.equal(evaluateEnterprisePreflight(complete).status,"PREFLIGHT_PASSED");
  assert.equal(finalSubmissionGate({...complete,externalActionReleaseValid:false,finalUserConfirmationValid:false,alreadyTransmitted:false}).status,"FINAL_APPROVAL_REQUIRED");
  assert.equal(finalSubmissionGate({...complete,externalActionReleaseValid:true,finalUserConfirmationValid:true,alreadyTransmitted:false}).status,"READY_FOR_FINAL_SUBMISSION");
  const duplicate=finalSubmissionGate({...complete,externalActionReleaseValid:true,finalUserConfirmationValid:true,alreadyTransmitted:true});
  assert.equal(duplicate.status,"FINAL_APPROVAL_REQUIRED");
  assert.ok(duplicate.blockers.some(item=>item.code==="IDENTICAL_SUBMISSION_EXISTS"));
});

test("submission state advancement is idempotent and rejects an illegal jump",()=>{
  const initial={contextId:"context-1",status:"WAITING_FOR_SESSION",bindingSha256:hash,processedKeys:[],transmitted:false};
  const connected=advanceSubmissionState(initial,"SESSION_READY",{reason:"VERIFIED_LOGIN",transmitted:false});
  assert.equal(connected.status,"SESSION_READY");
  const replay=advanceSubmissionState(connected,"SESSION_READY",{reason:"VERIFIED_LOGIN",transmitted:false});
  assert.equal(replay.idempotent,true);
  assert.throws(()=>advanceSubmissionState(connected,"SESSION_READY",{reason:"DIFFERENT_EVENT",transmitted:false}),{code:"SUBMISSION_TRANSITION_INVALID"});
  assert.throws(()=>advanceSubmissionState(initial,"SUBMITTED",{reason:"SKIP",transmitted:false}),{code:"SUBMISSION_TRANSITION_INVALID"});
});

test("all declared portal submission adapters validate packages but refuse external execution",async()=>{
  assert.ok(Object.keys(submissionAdapters).length>0);
  for(const adapter of Object.values(submissionAdapters)){
    const internal=await adapter.buildInternalPackage({scope,documents:[{id:"doc-1",category:"PRICE",filename:"preis.pdf",sha256:hash,sizeBytes:123}],fields:{price:"100.00"}});
    assert.equal((await adapter.validateInternalPackage(internal)).status,"INTERNAL_PACKAGE_VALID");
    const plan=await adapter.planPortalStaging({scope});
    assert.equal(plan.status,"EXTERNAL_STAGING_UNSUPPORTED");
    assert.equal(plan.externalWrite,false);
    await assert.rejects(()=>adapter.submit({scope}),{code:"AUTOPILOT_SUBMISSION_NOT_IMPLEMENTED"});
  }
});

test("acceptance sandbox can inspect and preflight but can never submit",async()=>{
  const adapter=acceptanceSandboxAdapter();
  assert.equal((await adapter.preflight({scope})).environment,"ISOLATED_ACCEPTANCE");
  await assert.rejects(()=>adapter.submit({scope}),(error)=>error.code==="EXTERNAL_SUBMISSION_LOCKED"&&error.httpStatus===423&&error.transmitted===false);
});

test("read-only event monitoring is exact-scope, idempotent and persists no external effect",async()=>{
  const observedAt="2026-08-22T08:00:00Z",now=()=>new Date("2026-08-22T08:01:00Z");
  const event=normalizeInboundEvent({type:"MESSAGE",externalEventId:"msg-1",scope,observedAt,payload:{subject:"Nachtrag",deadline:"2026-08-24T10:00:00Z"},sourceMode:"READ_ONLY_POLL"},{now});
  const history=reconcilePortalHistory([event,event]);
  assert.equal(history.duplicates,1);
  assert.equal(history.events.length,1);
  const result=await runReconciliationJob({jobKind:"MESSAGE_POLL",scope,attempt:0,maxAttempts:3},{now,poll:async input=>[{...event,scope:input.scope}]});
  assert.equal(result.status,"SUCCEEDED");
  assert.equal(result.events[0].transmitted,false);
  const wrong=await runReconciliationJob({jobKind:"MESSAGE_POLL",scope,attempt:3,maxAttempts:3},{now,poll:async()=>[{...event,scope:{...scope,companyId:"wrong"}}]});
  assert.equal(wrong.status,"DEAD_LETTER");
  assert.equal(wrong.errorClass,"SCOPE_MISMATCH");
});

test("submission fingerprint changes for company, portal, lot or released versions",()=>{
  const base={...scope,portalAdapterId:"adapter",approvalRequestId:"approval",bidPackageId:"package",bidPackageVersion:1,documentVersion:1,calculationVersion:1,managementVersion:1,bidVersion:1,deadline:"2026-09-01T10:00:00Z"};
  const values=[base,{...base,companyId:"other"},{...base,portalId:"other"},{...base,lotKey:"LOT-2"},{...base,calculationVersion:2}].map(submissionFingerprint);
  assert.equal(new Set(values).size,values.length);
});
