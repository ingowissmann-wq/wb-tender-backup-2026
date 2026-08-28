import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
const migration=readFileSync(new URL("../migrations/147_public_document_production_validated_scope.sql",import.meta.url),"utf8");
const worker=readFileSync(new URL("../platform/autopilot-pipeline-worker.mjs",import.meta.url),"utf8");
const routes=readFileSync(new URL("../platform/autopilot-routes.mjs",import.meta.url),"utf8");
test("verified public reads remain allowed after maturity promotion",()=>{
  for(const source of [migration,worker,routes])assert.match(source,/VALIDATED','VALIDATED_READ_ONLY','PRODUCTION_VALIDATED/);
  assert.match(migration,/NEW\.credential_id IS NULL/);
  assert.doesNotMatch(migration,/public_read_scope_valid:=NEW\.action_type IN\([^)]*SUBMIT/s);
});
