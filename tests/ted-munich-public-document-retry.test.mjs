import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
const source=readFileSync(new URL("../scripts/retry-ted-munich-public-documents.mjs",import.meta.url),"utf8");
test("retry is exact, hash-bound, targetable, zero-download only and submission inert",()=>{
  assert.match(source,/public_document_retry_plan_hash_mismatch/);
  assert.match(source,/documents_downloaded\)!==0/);
  assert.match(source,/job\.credential_id IS NULL/);
  assert.match(source,/job\.portal_id='71c824fd-1775-47f8-ae48-2d1c73b5e851'/);
  assert.match(source,/public_document_retry_target_not_allowed/);
  assert.match(source,/updated!==selected\.length/);
  assert.match(source,/terminal_result=NULL/);
  assert.match(source,/'DEAD_LETTER'/);
  assert.doesNotMatch(source,/action_type='(?:SUBMIT|BINDING_SUBMISSION|UPLOAD)'/);
  assert.match(source,/externalSubmission:false,transmitted:false/);
});
