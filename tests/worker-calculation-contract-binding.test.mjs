import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const worker = await readFile(
  new URL("../platform/autopilot-pipeline-worker.mjs", import.meta.url),
  "utf8",
);

test("production worker reaches the pricing engine only through the canonical contract", () => {
  assert.match(worker, /runPipelineCalculationContract/);
  assert.doesNotMatch(worker, /\bcalculateSectorTender\b/);
  assert.match(worker, /contractExecution\.calculation/);
  assert.match(worker, /CALCULATION_BLOCKED_CONTRACT/);
});

test("worker stores schema-4 snapshot and calculation binding in one transaction", () => {
  const begin = worker.indexOf('await calculationClient.query("BEGIN")');
  const snapshot = worker.indexOf("INSERT INTO tender.calculation_input_snapshots", begin);
  const calculation = worker.indexOf("INSERT INTO tender.calculations(", snapshot);
  const commit = worker.indexOf('await calculationClient.query("COMMIT")', calculation);
  assert.ok(begin >= 0 && snapshot > begin && calculation > snapshot && commit > calculation);
  const transaction = worker.slice(begin, commit);
  assert.match(transaction, /schema_version,snapshot_sha256,contract_version,contract_state/);
  assert.match(transaction, /engine_input,fact_records,parameter_records,document_fingerprints,rule_types/);
  assert.match(transaction, /calculation_input_snapshot_id/);
  assert.match(transaction, /inputRow\.id/);
  assert.doesNotMatch(transaction, /schema_version[^\n]*1/);
});

test("worker admits only approved parameters and exact document locations", () => {
  assert.match(worker, /version\.approved_by IS NOT NULL AND version\.approved_at IS NOT NULL/);
  assert.match(worker, /ACTIVE_APPROVED_EXACT_CONFIGURATION_SCOPE/);
  assert.match(worker, /exactDocumentFactRecord/);
  assert.match(worker, /Fact lacks an exact document hash and page, worksheet, row or cell locator/);
  assert.match(worker, /No released deterministic calculation contract exists/);
});

test("worker preserves canonical conditional-cost partial status", () => {
  assert.match(worker, /engineResult\.status === "CALCULATION_PARTIAL"/);
  assert.match(worker, /status = partial\s*\? "CALCULATION_PARTIAL"/);
  assert.doesNotMatch(worker, /status = !blocked\s*\? "CALCULATED_REAL"/);
});
