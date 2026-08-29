import assert from "node:assert/strict";
import test from "node:test";

import {buildManagementOutput} from "../platform/sector-calculation.mjs";

const base = {
  tender: {buyer: "Buyer", title: "Tender", offer_deadline: "2026-09-30T10:00:00Z"},
  lotKey: "LOT-0001",
  company: {sector_slug: "cleaning"},
  profileSnapshot: {id: "profile-1", revision: 147},
  documentRevision: "document-revision-1",
  calculation: {
    schemaVersion: 5,
    status: "CALCULATION_PARTIAL",
    productiveHours: 28023.66,
    fte: 8.39,
    calculationHash: "a".repeat(64),
    inputSnapshotSha256: "b".repeat(64),
    externalTransmission: false,
  },
  missing: [{field: "kilometers", reason: "MISSING_INPUT"}],
};

test("management content hash ignores execution receipt fields but receipt hash preserves them", () => {
  const first = buildManagementOutput({...base, jobId: "job-1", correlationId: "request-1", now: "2026-08-29T16:00:00Z"});
  const replay = buildManagementOutput({...base, jobId: "job-2", correlationId: "request-2", now: "2026-08-29T17:00:00Z"});
  assert.equal(first.schemaVersion, 4);
  assert.equal(first.provenance.managementOutputVersion, 4);
  assert.equal(first.outputHash, replay.outputHash);
  assert.notEqual(first.receiptHash, replay.receiptHash);
  assert.equal(first.externalTransmission, false);
});

test("management content hash changes with the bound calculation snapshot", () => {
  const first = buildManagementOutput({...base, now: "2026-08-29T16:00:00Z"});
  const changed = buildManagementOutput({
    ...base,
    calculation: {...base.calculation, inputSnapshotSha256: "c".repeat(64)},
    now: "2026-08-29T16:00:00Z",
  });
  assert.notEqual(first.outputHash, changed.outputHash);
});
