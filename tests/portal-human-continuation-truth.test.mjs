import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const worker=fs.readFileSync(new URL("../platform/autopilot-pipeline-worker.mjs",import.meta.url),"utf8");
const migration=fs.readFileSync(new URL("../migrations/136_portal_human_continuation_truth.sql",import.meta.url),"utf8");
const rollback=fs.readFileSync(new URL("../migrations/136_portal_human_continuation_truth.down.sql",import.meta.url),"utf8");

test("portal prerequisites become explicit safe continuation states",()=>{
  for(const status of ["ACCOUNT_SETUP_REQUIRED","MANUAL_MFA_REQUIRED","MANUAL_CAPTCHA_REQUIRED"])
    assert.match(worker,new RegExp(status));
  assert.match(worker,/status='CANCELLED',current_step='HUMAN_ACTION_REQUIRED'/);
  assert.match(worker,/portal_human_continuation_required/);
  assert.match(worker,/externalWrite: false/);
});

test("migration 136 reclassifies only enumerated external prerequisites without deletion",()=>{
  assert.match(migration,/REGISTERED_PORTAL_SCOPE_NOT_FOUND/);
  assert.match(migration,/MFA_BESTÄTIGUNG_ERFORDERLICH/);
  assert.match(migration,/CAPTCHA_MANUELL_ERFORDERLICH/);
  assert.match(migration,/queue\.status='DEAD_LETTER'/);
  assert.match(migration,/physicalDeletes',0/);
  assert.doesNotMatch(migration,/DELETE FROM tender\.autopilot_queue/);
});

test("rollback is version-marker bound and restores prior safe fields",()=>{
  assert.match(rollback,/portal-human-continuation-v1/);
  assert.match(rollback,/originalQueueStatus/);
  assert.match(rollback,/originalReasonCode/);
  assert.match(rollback,/originalTerminalAt/);
});
