import assert from "node:assert/strict";
import test from "node:test";

import {executeCalculationContractSnapshot} from "../platform/calculation-contract.mjs";
import {runPipelineCalculationContract} from "../platform/pipeline-calculation-contract.mjs";

const scope = {
  tenantId: "tenant-1",
  companyId: "company-1",
  tenderId: "tender-1",
  lotId: "lot-1",
  lotKey: "LOT-0001",
};
const sha = "a".repeat(64);
const engineInput = {
  serviceArea: "cleaning",
  parameters: {C01: 15.5, C23: 1670},
  units: {C01: "EUR_PER_HOUR", C23: "HOURS_PER_YEAR"},
  facts: {productiveHours: 100, duration: 12},
};
const parameterRecords = Object.entries(engineInput.parameters).map(([key, value]) => ({
  key,
  value,
  unit: engineInput.units[key],
  classification: "COMPANY_APPROVED",
  scope: {tenantId: scope.tenantId, companyId: scope.companyId, serviceArea: "cleaning"},
  source: "ACTIVE_APPROVED_EXACT_CONFIGURATION_SCOPE",
  versionId: `version-${key}`,
  approvedBy: "board-1",
  approvedAt: "2026-08-29T16:00:00Z",
}));
const factRecords = ["productiveHours", "duration"].map(key => ({
  key,
  value: engineInput.facts[key],
  unit: key === "duration" ? "MONTHS" : "HOURS",
  scope,
  classification: "DOCUMENT_VERIFIED",
  source: {
    type: "VERIFIED_PROCUREMENT_DOCUMENT",
    documentId: "document-1",
    documentSha256: sha,
    location: {page: 1},
  },
}));

test("pipeline executes only one ready immutable contract snapshot", () => {
  const execution = runPipelineCalculationContract({
    scope,
    engineInput,
    parameterRecords,
    factRecords,
    documentFingerprints: [{documentId: "document-1", sha256: sha}],
  });
  assert.equal(execution.status, "CALCULATION_CONTRACT_EXECUTED");
  assert.equal(execution.snapshot.state, "READY");
  assert.equal(execution.calculation.inputSnapshotSha256, execution.snapshot.snapshotSha256);
  assert.equal(execution.calculation.status, "CALCULATED");
  assert.equal(execution.externalTransmission, false);
});

test("pipeline hashes missing input into a non-executable quarantined snapshot", () => {
  const blockingReasons = [{
    key: "kilometers",
    classification: "MISSING_INPUT",
    reason: "C13/C14 are configured but no verified kilometer quantity exists",
    nextAction: "Management must enter an exact tender/company/lot-bound kilometer quantity",
  }];
  const first = runPipelineCalculationContract({
    scope,
    engineInput,
    parameterRecords,
    factRecords,
    documentFingerprints: [{documentId: "document-1", sha256: sha}],
    blockingReasons,
  });
  const replay = runPipelineCalculationContract({
    scope,
    engineInput,
    parameterRecords,
    factRecords,
    documentFingerprints: [{documentId: "document-1", sha256: sha}],
    blockingReasons,
  });
  assert.equal(first.status, "CALCULATION_BLOCKED_CONTRACT");
  assert.equal(first.snapshot.state, "QUARANTINED");
  assert.equal(first.calculation, null);
  assert.equal(first.snapshot.snapshotSha256, replay.snapshot.snapshotSha256);
  assert.throws(
    () => executeCalculationContractSnapshot(first.snapshot),
    /CALCULATION_CONTRACT_STATE_NOT_EXECUTABLE/,
  );
});
