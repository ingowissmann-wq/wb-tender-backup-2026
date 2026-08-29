import test from "node:test";
import assert from "node:assert/strict";
import {
  CALCULATION_CONTRACT_STATES,
  createAiExtractionCandidate,
  createCalculationContractSnapshot,
  executeCalculationContractSnapshot,
  validateCalculationContractInput,
} from "../platform/calculation-contract.mjs";

const sha = "a".repeat(64);
const scope = {tenantId: "tenant-1", companyId: "company-1", tenderId: "tender-1", lotId: "lot-1", lotKey: "LOT-0001"};
const documentFingerprints = [{documentId: "document-1", sha256: sha, parserVersion: "xlsx/1"}];
const fact = (key, value, unit, extra = {}) => ({
  key, value, unit, scope, classification: "DOCUMENT_VERIFIED",
  source: {type: "VERIFIED_PROCUREMENT_DOCUMENT", documentId: "document-1", documentSha256: sha, location: {worksheet: "P4, Aufmaß", row: 12}},
  ...extra,
});
const ruleTypes = [{id: "cleaning-area-hours", version: 1, gitCommit: "f862ceb", status: "ACTIVE", testEvidence: "test-1", shadowEvidence: "shadow-1", approvedBy: "board-1"}];
const engineInput = {
  serviceArea: "cleaning",
  parameters: {C01: 15.5, C13: 1.2, C14: 0.4, C23: 1670},
  units: {C13: "EUR_PER_KM", C14: "EUR_PER_KM", C23: "HOURS_PER_YEAR"},
  facts: {productiveHours: 28023.66, duration: 24},
};
const parameterRecords = Object.entries(engineInput.parameters).map(([key, value]) => ({
  key, value, unit: engineInput.units[key] || "PERCENT",
  classification: "COMPANY_APPROVED",
  scope: {tenantId: scope.tenantId, companyId: scope.companyId, serviceArea: engineInput.serviceArea},
  source: "ACTIVE_APPROVED_EXACT_CONFIGURATION_SCOPE",
  versionId: `version-${key}`,
  approvedBy: "board-1",
  approvedAt: "2026-08-29T16:00:00Z",
}));

test("one immutable hashed snapshot is the exact calculation engine input", () => {
  const snapshot = createCalculationContractSnapshot({
    scope, engineInput, documentFingerprints, ruleTypes, parameterRecords,
    factRecords: [fact("productiveHours", 28023.66, "HOURS"), fact("duration", 24, "MONTHS")],
    state: CALCULATION_CONTRACT_STATES.SHADOW,
  });
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.engineInput.facts));
  const result = executeCalculationContractSnapshot(snapshot);
  assert.equal(result.status, "CALCULATION_PARTIAL");
  assert.deepEqual(result.unappliedConditionalCosts.map(item => item.parameterKey), ["C13", "C14"]);
  assert.equal(result.inputSnapshotSha256, snapshot.snapshotSha256);
});

test("document facts require exact source location and the matching fingerprint", () => {
  const validation = validateCalculationContractInput({
    scope, engineInput, documentFingerprints, parameterRecords,
    factRecords: [
      {...fact("productiveHours", 28023.66, "HOURS"), source: {type: "VERIFIED_PROCUREMENT_DOCUMENT", documentId: "document-1", documentSha256: "b".repeat(64)}},
      fact("duration", 24, "MONTHS", {source: {type: "VERIFIED_PROCUREMENT_DOCUMENT", documentId: "document-1", documentSha256: sha}}),
    ],
  });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.code === "FACT_DOCUMENT_HASH_MISMATCH"));
  assert.ok(validation.errors.some(error => error.code === "FACT_EXACT_LOCATION_MISSING"));
});

test("an aggregate fact may bind multiple exact document locations", () => {
  const secondSha = "b".repeat(64);
  const aggregate = {
    key: "productiveHours", value: 28023.66, unit: "HOURS", scope, classification: "DOCUMENT_VERIFIED",
    source: {
      type: "VERIFIED_PROCUREMENT_DOCUMENT_SET",
      evidence: [
        {documentId: "document-1", documentSha256: sha, location: {worksheet: "P4, Aufmaß", rowStart: 12, rowEnd: 917}},
        {documentId: "document-2", documentSha256: secondSha, location: {page: 7}},
      ],
    },
  };
  const validation = validateCalculationContractInput({
    scope, engineInput,
    documentFingerprints: [...documentFingerprints, {documentId: "document-2", sha256: secondSha}],
    parameterRecords,
    factRecords: [aggregate, fact("duration", 24, "MONTHS")],
  });
  assert.equal(validation.valid, true);
});

test("every member of a document evidence set needs its matching hash and exact locator", () => {
  const validation = validateCalculationContractInput({
    scope, engineInput, documentFingerprints, parameterRecords,
    factRecords: [{
      key: "productiveHours", value: 28023.66, unit: "HOURS", scope, classification: "DOCUMENT_VERIFIED",
      source: {type: "VERIFIED_PROCUREMENT_DOCUMENT_SET", evidence: [
        {documentId: "document-1", documentSha256: "b".repeat(64), location: {worksheet: "P4, Aufmaß"}},
      ]},
    }, fact("duration", 24, "MONTHS")],
  });
  const codes = validation.errors.map(error => error.code);
  assert.ok(codes.includes("FACT_DOCUMENT_HASH_MISMATCH"));
  assert.ok(codes.includes("FACT_EXACT_LOCATION_MISSING"));
});

test("ranges, option terms and cross-scope facts cannot enter production", () => {
  const validation = validateCalculationContractInput({
    scope,
    engineInput: {...engineInput, facts: {productiveHours: {minimum: 100, maximum: 120}, duration: 60}},
    documentFingerprints,
    parameterRecords,
    factRecords: [
      fact("productiveHours", {minimum: 100, maximum: 120}, "HOURS", {scope: {...scope, companyId: "other-company"}}),
      fact("duration", 60, "MONTHS", {termType: "OPTION"}),
    ],
  });
  const codes = validation.errors.map(error => error.code);
  assert.ok(codes.includes("RANGE_REQUIRES_EXPLICIT_SELECTION"));
  assert.ok(codes.includes("OPTION_TERM_CANNOT_BE_BASE_TERM"));
  assert.ok(codes.includes("CROSS_SCOPE_FACT"));
});

test("missing, conflicting and outside-range classifications block the snapshot", () => {
  for (const classification of ["MISSING_INPUT", "CONFLICTING_EVIDENCE", "OUTSIDE_ALLOWED_RANGE"]) {
    const validation = validateCalculationContractInput({
      scope, engineInput, documentFingerprints, parameterRecords,
      factRecords: [
        {...fact("productiveHours", 28023.66, "HOURS"), classification},
        fact("duration", 24, "MONTHS"),
      ],
    });
    assert.ok(validation.errors.some(error =>
      error.code === "FACT_CLASSIFICATION_BLOCKING" && error.classification === classification));
  }
});

test("an approved management input may supply the missing exact kilometer quantity", () => {
  const kilometerFact = {
    key: "kilometers", value: 900, unit: "KM", scope, classification: "CASE_APPROVED",
    source: {type: "EXPLICIT_MANAGEMENT_INPUT", inputId: "input-1", approvedBy: "fe93f980-5699-44f4-ad41-69d254dcaa9f", approvedAt: "2026-08-29T16:00:00Z"},
  };
  const snapshot = createCalculationContractSnapshot({
    scope,
    engineInput: {...engineInput, facts: {...engineInput.facts, kilometers: 900}},
    documentFingerprints,
    parameterRecords,
    factRecords: [fact("productiveHours", 28023.66, "HOURS"), fact("duration", 24, "MONTHS"), kilometerFact],
    state: CALCULATION_CONTRACT_STATES.SHADOW,
  });
  const result = executeCalculationContractSnapshot(snapshot);
  assert.equal(result.status, "CALCULATED");
  assert.equal(result.vehicles, 1080);
  assert.equal(result.travel, 360);
});

test("calculation parameters require approved exact company and service scope", () => {
  const validation = validateCalculationContractInput({
    scope, engineInput, documentFingerprints,
    parameterRecords: parameterRecords
      .filter(record => record.key !== "C13")
      .map(record => record.key === "C23" ? {...record, scope: {...record.scope, companyId: "other-company"}} : record),
    factRecords: [fact("productiveHours", 28023.66, "HOURS"), fact("duration", 24, "MONTHS")],
  });
  assert.ok(validation.errors.some(error => error.code === "PARAMETER_EVIDENCE_MISSING" && error.parameterKey === "C13"));
  assert.ok(validation.errors.some(error => error.code === "CROSS_SCOPE_PARAMETER" && error.parameterKey === "C23"));
});

test("deterministic derivations bind their exact versioned rule and evidenced inputs", () => {
  const annualArea = fact("annualCleaningArea", 2589414.889362, "SQUARE_METRES_PER_YEAR");
  const performance = {
    key: "cleaningPerformance", value: 195, unit: "SQUARE_METRES_PER_HOUR", scope, classification: "CASE_APPROVED",
    source: {type: "EXPLICIT_MANAGEMENT_INPUT", inputId: "performance-1", approvedBy: "board-1", approvedAt: "2026-08-29T16:00:00Z"},
  };
  const productiveHours = {
    key: "productiveHours", value: 28023.66, unit: "HOURS", scope, classification: "DETERMINISTIC_DERIVED",
    source: {type: "DETERMINISTIC_DERIVATION", ruleTypeId: "cleaning-area-hours", ruleVersion: 1, inputFactKeys: ["annualCleaningArea", "cleaningPerformance", "duration"], inputParameterKeys: ["C23"]},
  };
  const validation = validateCalculationContractInput({
    scope, engineInput, documentFingerprints, parameterRecords, ruleTypes,
    factRecords: [annualArea, performance, productiveHours, fact("duration", 24, "MONTHS")],
  });
  assert.equal(validation.valid, true);
});

test("AI extraction stays hashed, quarantined from execution and distrusts document instructions", () => {
  const candidate = createAiExtractionCandidate({scope, documentFingerprint: documentFingerprints[0], candidates: [fact("duration", 24, "MONTHS")]});
  assert.equal(candidate.status, "NEW_TENDER_TYPE_CANDIDATE");
  assert.equal(candidate.executable, false);
  assert.equal(candidate.persistedAsProductionFact, false);
  assert.equal(candidate.documentInstructionsTrusted, false);
  assert.throws(() => executeCalculationContractSnapshot({...candidate, snapshotSha256: candidate.candidateSnapshotSha256}), /HASH_MISMATCH|STATE_NOT_EXECUTABLE/);
});

test("the manual calculator is explicitly non-persistent and still uses the same server engine", () => {
  const snapshot = createCalculationContractSnapshot({
    mode: "MANUAL_SANDBOX",
    state: CALCULATION_CONTRACT_STATES.SHADOW,
    engineInput: {serviceArea: "cleaning", parameters: {C01: 15.5, C23: 1670}, units: {C23: "HOURS_PER_YEAR"}, facts: {productiveHours: 100, duration: 12}},
  });
  const result = executeCalculationContractSnapshot(snapshot);
  assert.equal(result.status, "CALCULATED");
});
