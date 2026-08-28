import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../platform/server.mjs", import.meta.url), "utf8");
const worker = readFileSync(new URL("../platform/autopilot-pipeline-worker.mjs", import.meta.url), "utf8");
const recalculation = readFileSync(new URL("../platform/region-recalculation-worker.mjs", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/121_region_recalculation_worker_ownership.sql", import.meta.url), "utf8");

test("API process does not own the region recalculation consumer", () => {
  assert.doesNotMatch(server, /startRegionRecalculationWorker/);
});

test("autopilot worker exclusively starts and stops the region consumer", () => {
  assert.match(worker, /startRegionRecalculationWorker\(pool/);
  assert.match(worker, /regionRecalculationWorker\?\.stop\(\)/);
  assert.match(recalculation, /region-worker:/);
});

test("database rejects legacy API leases while rollback images remain online", () => {
  assert.match(migration, /lease_owner NOT LIKE 'region-worker:%'/);
  assert.match(migration, /status <> 'RUNNING'[\s\S]*lease_owner LIKE 'region-worker:%'/);
});
