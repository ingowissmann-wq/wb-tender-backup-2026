import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const script=await readFile(new URL("../scripts/isolated-c23-migration-rehearsal.sh",import.meta.url),"utf8");

test("isolated C23 rehearsal is source-bound, clone-only and reversible",()=>{
  assert.match(script,/EXPECTED_COMMIT is required/);
  assert.match(script,/source commit mismatch/);
  assert.match(script,/expected exactly one running isolated restore container/);
  assert.match(script,/restore container publishes host ports/);
  assert.match(script,/0154-phase2-company-scoped-resolver-jobs/);
  assert.match(script,/migration 155 ledger must be absent/);
  assert.match(script,/APPLY UP[\s\S]*APPLY DOWN[\s\S]*REAPPLY UP/);
  assert.match(script,/externalActionReceipts/);
  assert.match(script,/c23Changes/);
  assert.match(script,/rlsMissing/);
  assert.match(script,/protected data remained identical/);
  assert.doesNotMatch(script,/docker\s+(?:rm|volume rm|network rm)|DROP DATABASE|TRUNCATE|DELETE FROM tender\./);
});
