import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const worker=fs.readFileSync(new URL("../platform/autopilot-pipeline-worker.mjs",import.meta.url),"utf8");
const migration=fs.readFileSync(new URL("../migrations/135_participation_terminal_truth.sql",import.meta.url),"utf8");
const rollback=fs.readFileSync(new URL("../migrations/135_participation_terminal_truth.down.sql",import.meta.url),"utf8");

test("expected non-participation is a terminal cancellation, never a technical dead letter",()=>{
  assert.match(worker,/status='CANCELLED',current_step='PARTICIPATION_BLOCKED'/);
  assert.match(worker,/terminal_result='NOT_PARTICIPATION_ELIGIBLE'/);
  assert.match(worker,/terminalClassificationVersion/);
  assert.match(worker,/originalReasonCode',\$2::text/);
  assert.doesNotMatch(worker,/status='DEAD_LETTER',current_step='PARTICIPATION_BLOCKED'/);
});

test("migration 135 only reclassifies the exact historical false-error shape",()=>{
  assert.match(migration,/status='DEAD_LETTER'/);
  assert.match(migration,/current_step='PARTICIPATION_BLOCKED'/);
  assert.match(migration,/error_code='TENDER_NOT_PARTICIPATION_ELIGIBLE'/);
  assert.match(migration,/terminal_result IS NULL/);
  assert.match(migration,/physicalDeletes',0/);
  assert.doesNotMatch(migration,/DELETE FROM tender\.autopilot_queue/);
});

test("migration 135 rollback is marker-bound and restores the exact prior classification",()=>{
  assert.match(rollback,/terminalClassificationVersion/);
  assert.match(rollback,/originalQueueStatus/);
  assert.match(rollback,/status='DEAD_LETTER'/);
  assert.match(rollback,/error_code='TENDER_NOT_PARTICIPATION_ELIGIBLE'/);
});
