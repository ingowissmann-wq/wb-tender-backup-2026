import assert from "node:assert/strict";
import test from "node:test";
import {submissionAdapters,submissionAdapterFor} from "../platform/submission-adapters.mjs";
import {SUBMISSION_ADAPTER_METHODS,validateSubmissionAdapter} from "../platform/submission-framework.mjs";

const scope={tenderId:"11111111-1111-4111-8111-111111111111",
  companyId:"22222222-2222-4222-8222-222222222222",lotKey:"LOT-1",
  portalId:"33333333-3333-4333-8333-333333333333",credentialId:null};
const documents=[{id:"44444444-4444-4444-8444-444444444444",category:"PRICE_SHEET",
  filename:"preisblatt.pdf",sha256:"a".repeat(64),sizeBytes:1024}];

test("every declared adapter completes the same non-transmitting submission simulation",async()=>{
  assert.ok(Object.keys(submissionAdapters).length>=16);
  for(const [portalCode,adapter] of Object.entries(submissionAdapters)){
    validateSubmissionAdapter(adapter);
    assert.deepEqual(SUBMISSION_ADAPTER_METHODS.filter(method=>typeof adapter[method]!=="function"),[]);
    const packageValue=await adapter.buildInternalPackage({scope,documents,fields:{priceNet:"100.00"}});
    assert.equal((await adapter.validateInternalPackage(packageValue)).status,"INTERNAL_PACKAGE_VALID",portalCode);
    const result=await adapter.simulateSubmission({package:packageValue,confirmation:"SIMULATION_ONLY",
      deadlineOpen:true,requiredDocumentsComplete:true,packageHashApproved:true,allowExternalWrite:false});
    assert.equal(result.status,"SIMULATED_RECEIPT_VERIFIED",portalCode);
    assert.equal(result.transmitted,false,portalCode);
    assert.equal(result.externalWrite,false,portalCode);
    assert.equal(result.receipt.portalTransactionId,null,portalCode);
    assert.match(result.receipt.receiptSha256,/^[a-f0-9]{64}$/,portalCode);
    assert.equal(adapter.productionValidated,false,portalCode);
    await assert.rejects(adapter.submit({}),error=>error.code==="AUTOPILOT_SUBMISSION_NOT_IMPLEMENTED",portalCode);
  }
});

test("simulation fails closed on hash drift, missing lot or any external-write request",async()=>{
  const adapter=submissionAdapters[Object.keys(submissionAdapters)[0]];
  const packageValue=await adapter.buildInternalPackage({scope,documents,fields:{}});
  packageValue.packageSha256="b".repeat(64);
  const drift=await adapter.simulateSubmission({package:packageValue,confirmation:"SIMULATION_ONLY",
    deadlineOpen:true,requiredDocumentsComplete:true,packageHashApproved:true});
  assert.equal(drift.status,"SIMULATION_BLOCKED");
  assert.ok(drift.blockers.some(item=>item.code==="PACKAGE_HASH_INVALID"));
  const noLot=await adapter.buildInternalPackage({scope:{...scope,lotKey:""},documents,fields:{}});
  assert.ok((await adapter.validateInternalPackage(noLot)).blockers.some(item=>item.code==="PACKAGE_SCOPE_INCOMPLETE"));
  const valid=await adapter.buildInternalPackage({scope,documents,fields:{}});
  const external=await adapter.simulateSubmission({package:valid,confirmation:"SIMULATION_ONLY",
    deadlineOpen:true,requiredDocumentsComplete:true,packageHashApproved:true,allowExternalWrite:true});
  assert.ok(external.blockers.some(item=>item.code==="SIMULATION_EXTERNAL_WRITE_FORBIDDEN"));
  assert.equal(external.transmitted,false);
});

test("every dynamically discovered registry adapter receives the complete fail-closed contract",async()=>{
  const adapter=submissionAdapterFor("unknown-registry-family-123");
  assert.equal(adapter,submissionAdapterFor("unknown-registry-family-123"));
  validateSubmissionAdapter(adapter);
  assert.equal(adapter.portalCode,"unknown-registry-family-123");
  assert.equal(adapter.productionValidated,false);
  const inspection=await adapter.inspectRequiredFields({scope});
  assert.equal(inspection.status,"PORTAL_EVIDENCE_REQUIRED");
  assert.equal(inspection.requiredAction.type,"PORTAL_OPERATOR_SANDBOX_REQUIRED");
  assert.equal(inspection.externalWrite,false);
  await assert.rejects(adapter.submit({}),error=>{
    assert.equal(error.code,"AUTOPILOT_SUBMISSION_NOT_IMPLEMENTED");
    assert.equal(error.status,"UNSUPPORTED_PORTAL_REQUIRES_ADAPTER");
    assert.equal(error.operation,"submit");
    assert.equal(error.requiredAction.type,"PORTAL_OPERATOR_SANDBOX_REQUIRED");
    assert.equal(error.requiredAction.externalWrite,false);
    return true;
  });
  assert.throws(()=>submissionAdapterFor("../invalid"),error=>error.code==="SUBMISSION_ADAPTER_CODE_INVALID");
});
