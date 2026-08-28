import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

for (const workerPath of [
  "../platform/autopilot-pipeline-worker.mjs",
  "../deployment/context-portal-readiness-128-overlay/platform/autopilot-pipeline-worker.mjs",
]) {
  const workerUrl = new URL(workerPath, import.meta.url);
  if (!fs.existsSync(workerUrl)) continue;
  test(`management output first insert is serialized and scenario-bound: ${workerPath}`, () => {
    const source = fs.readFileSync(workerUrl, "utf8");
    const start = source.indexOf("async function persistManagementOutput");
    const end = source.indexOf("async function ensureManagementApprovalRequest", start);
    assert.ok(start >= 0 && end > start);
    const implementation = source.slice(start, end);
    assert.match(implementation, /SELECT id FROM tender\.tenders WHERE id=\$1 FOR UPDATE/);
    assert.match(implementation, /scenario_key='REAL' AND historical=false FOR UPDATE/);
    assert.match(implementation, /management_outputs\(tender_id,lot_key,company_id,scenario_key,/);
    assert.match(implementation, /VALUES\(\$1,\$2,\$3,'REAL',\$4/);
  });
}
