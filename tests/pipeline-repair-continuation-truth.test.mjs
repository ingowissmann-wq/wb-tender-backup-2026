import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root=fs.readFileSync(new URL("../platform/autopilot-pipeline-worker.mjs",import.meta.url),"utf8");
const overlayUrl=new URL("../deployment/context-portal-readiness-128-overlay/platform/autopilot-pipeline-worker.mjs",import.meta.url);
// In the release image the overlay is the shipped /app/platform worker itself.
const overlay=fs.existsSync(overlayUrl)?fs.readFileSync(overlayUrl,"utf8"):root;
const up=fs.readFileSync(new URL("../migrations/139_pipeline_repair_continuation_truth.sql",import.meta.url),"utf8");
const down=fs.readFileSync(new URL("../migrations/139_pipeline_repair_continuation_truth.down.sql",import.meta.url),"utf8");

for(const [name,worker] of [["root",root],["release overlay",overlay]]){
  test(`${name} worker emits executable non-technical repair continuations`,()=>{
    for(const value of ["DATA_CONTEXT_REPAIR_REQUIRED","ADAPTER_REPAIR_REQUIRED","UNSUPPORTED_PORTAL_REQUIRES_ADAPTER","EXTERNAL_PORTAL_UNAVAILABLE","repairAction","REPAIR_ACTION_REQUIRED"])
      assert.ok(worker.includes(value),value);
    assert.match(worker,/pipeline_repair_continuation_required/);
    assert.match(worker,/externalWrite: false/);
  });
}

test("migration preserves original terminal evidence and has a non-destructive rollback",()=>{
  assert.match(up,/originalQueueStatus/);
  assert.match(up,/originalErrorDetailSafe/);
  assert.match(up,/physicalDeletes',0/);
  assert.match(down,/pipeline-repair-continuation-v1/);
  assert.doesNotMatch(down,/DELETE FROM tender\.autopilot_queue/);
});
