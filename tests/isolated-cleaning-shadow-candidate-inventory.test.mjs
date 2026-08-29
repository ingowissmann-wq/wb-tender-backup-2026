import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const script=await readFile(new URL("../scripts/isolated-cleaning-shadow-candidate-inventory.sh",import.meta.url),"utf8");

test("Cleaning candidate inventory is source-bound, exact-scope and read-only",()=>{
  assert.match(script,/EXPECTED_COMMIT is required/);
  assert.match(script,/source commit mismatch/);
  assert.match(script,/exactly one running isolated restore container/);
  assert.match(script,/restore container publishes host ports/);
  assert.match(script,/BEGIN TRANSACTION READ ONLY/);
  assert.match(script,/0155-c23-canonical-calculation-contract/);
  assert.match(script,/configuration_scopes scope/);
  assert.match(script,/enrichment_context_bindings binding/);
  assert.match(script,/evaluation\.tenant_id=scope\.tenant_id/);
  assert.match(script,/evaluation\.profile_id=scope\.profile_id/);
  assert.match(script,/evaluation\.lot_id IS NOT DISTINCT FROM lot\.id/);
  assert.match(script,/CORE_REGION','STRATEGIC_REGION/);
  assert.match(script,/procurement_verification_status='VERIFIED'/);
  assert.match(script,/external_id='552392-2026'/);
  assert.match(script,/protected data remained identical/);
  assert.doesNotMatch(script,/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i);
});
