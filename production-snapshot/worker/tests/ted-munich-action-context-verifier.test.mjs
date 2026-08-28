import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const source=readFileSync(new URL("../scripts/verify-ted-munich-action-contexts-readonly.mjs",import.meta.url),"utf8");

test("verifier is read-only and checks the complete canonical action identity",()=>{
  assert.match(source,/default_transaction_read_only=on/);
  assert.doesNotMatch(source,/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  for(const field of ["tender_version_id","lot_id","enrichment_version_id","evaluation_version","service_line"])assert.match(source,new RegExp(field));
  assert.match(source,/context_integrity_status!=="CANONICAL"/);
  assert.match(source,/lot_identity_mismatch/);
  assert.match(source,/enrichment_identity_mismatch/);
});

test("verifier locks submission safety and distinguishes Munich roles from TED",()=>{
  assert.match(source,/submission_safety_not_locked/);
  assert.match(source,/evidence_role='PROCUREMENT_DOCUMENT'/);
  assert.match(source,/evidence_role='SUBMISSION'/);
  assert.match(source,/document_portal_domain!=="vergabe\.muenchen\.de"/);
  assert.match(source,/submission_portal_domain!=="vergabe\.muenchen\.de"/);
  assert.match(source,/externalWrite:false,transmitted:false/);
});
