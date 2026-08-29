import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const source=readFileSync(new URL("../scripts/enqueue-ted-munich-public-documents.mjs",import.meta.url),"utf8");

test("Munich queue plan is hash-bound, exact-context and download-only",()=>{
  assert.match(source,/public_document_plan_hash_mismatch/);
  assert.match(source,/context_integrity_status='CANONICAL'/);
  assert.match(source,/tender_lot_selections/);
  assert.match(source,/adapter_validation_status='VALIDATED_READ_ONLY'/);
  assert.match(source,/actionType:"FETCH_DOCUMENTS"/);
  assert.match(source,/credentialIds:\[\]/);
  assert.doesNotMatch(source,/['"](?:BINDING_SUBMISSION|UPLOAD|SUBMIT)['"]/);
});

test("apply stays idempotent, audited and submission-locked",()=>{
  assert.match(source,/ON CONFLICT DO NOTHING RETURNING id/);
  assert.match(source,/submission_safety_not_locked/);
  assert.match(source,/submission_safety_changed/);
  assert.match(source,/TED_MUNICH_PUBLIC_DOCUMENT_JOBS_QUEUED/);
  assert.match(source,/externalSubmission:false,transmitted:false/);
});
