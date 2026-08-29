import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const routes=readFileSync(new URL("../platform/autopilot-routes.mjs",import.meta.url),"utf8");
const worker=readFileSync(new URL("../platform/autopilot-pipeline-worker.mjs",import.meta.url),"utf8");

test("public TED documents resolve to one authoritative read-only portal instead of a null portal",()=>{
  assert.match(routes,/PUBLIC_DOCUMENT_PORTAL_NOT_UNIQUELY_VALIDATED/);
  assert.match(routes,/evidence_role='PROCUREMENT_DOCUMENT'/);
  assert.match(routes,/adapter_validation_status IN\('VALIDATED','VALIDATED_READ_ONLY','PRODUCTION_VALIDATED'\)/);
  assert.match(routes,/'PUBLIC_DOCUMENTS_POSSIBLE'=ANY/);
  assert.doesNotMatch(routes,/return \{ publicSource: true, portal_id: null, credential_id: null \}/);
});

test("worker permits credentialless read processing only for an exact validated public document scope",()=>{
  assert.match(worker,/credentiallessPublicActions=new Set/);
  assert.match(worker,/!item\.credential_id&&item\.portal_id&&credentiallessPublicActions\.has\(item\.action_type\)/);
  assert.match(worker,/resolution\.portal_id=\$2/);
  assert.match(worker,/link\.public_access=true/);
  assert.match(worker,/registered\.length !== 1\s*&&\s*publicReadScope\.length !== 1/);
  assert.doesNotMatch(worker,/credentiallessPublicActions=new Set\([^)]*BINDING_SUBMISSION/s);
  assert.doesNotMatch(worker,/credentiallessPublicActions=new Set\([^)]*UPLOAD/s);
});
