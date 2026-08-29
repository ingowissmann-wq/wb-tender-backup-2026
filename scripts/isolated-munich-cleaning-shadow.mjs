import fs from "node:fs/promises";

import {
  deriveCleaningRoomBookFacts,
  selectLotAuthoritativeDocuments,
} from "../platform/cleaning-room-book.mjs";
import {
  buildManagementOutput,
} from "../platform/sector-calculation.mjs";
import {
  CALCULATION_CONTRACT_STATES,
  createCalculationContractSnapshot,
  executeCalculationContractSnapshot,
} from "../platform/calculation-contract.mjs";

const [documentsPath, parametersPath, metadataPath, selectedEnrichmentLotId] =
  process.argv.slice(2);

if (!documentsPath || !parametersPath || !metadataPath || !selectedEnrichmentLotId)
  throw new Error(
    "usage: isolated-munich-cleaning-shadow.mjs DOCUMENTS_JSON PARAMETERS_JSON METADATA_JSON SELECTED_ENRICHMENT_LOT_ID",
  );

const [documents, parameterRows, metadata] = await Promise.all([
  fs.readFile(documentsPath, "utf8").then(JSON.parse),
  fs.readFile(parametersPath, "utf8").then(JSON.parse),
  fs.readFile(metadataPath, "utf8").then(JSON.parse),
]);

const expected = Object.freeze({
  externalId: "552392-2026",
  tenderId: "2203e521-6be7-4760-a15e-1357f833b279",
  companyId: "15c3c602-aa51-4dd4-adc1-3586dc82e523",
  lotKey: "LOT-0000",
  enrichmentVersionId: "f00be7ac-3de5-487b-b867-fe859e45c14a",
  annualCleaningArea: 163483.68,
  cleaningPerformance: 225,
  contractMonths: 48,
  productiveHours: 2906.38,
  annualHours: 726.59,
  monthlyHours: 60.55,
  fteAnnualHours: 1670,
  fte: 0.44,
  material: 1453.19,
  totalPrice: 102572.2,
  hourlyRate: 35.29,
  annualPrice: 25643.05,
});

const exact = (actual, wanted, label) => {
  if (actual !== wanted)
    throw new Error(`${label} mismatch: expected=${wanted} actual=${actual}`);
};

exact(metadata?.tender?.externalId, expected.externalId, "external tender id");
exact(metadata?.tender?.id, expected.tenderId, "tender id");
exact(metadata?.company?.id, expected.companyId, "company id");
exact(metadata?.lot?.key, expected.lotKey, "lot key");
exact(
  metadata?.lot?.enrichmentVersionId,
  expected.enrichmentVersionId,
  "enrichment version id",
);

if (!Array.isArray(documents) || !documents.length)
  throw new Error("verified Munich document set is empty");
if (documents.some(document => document.procurement_verification_status !== "VERIFIED"))
  throw new Error("unverified document entered the Munich shadow set");
if (!Array.isArray(parameterRows) || !parameterRows.length)
  throw new Error("active exact-scope Cleaning parameters are empty");
if (parameterRows.some(row => row.parameter_key === "C22"))
  throw new Error("C22 must not be persisted for this case-specific shadow replay");

const c23Rows = parameterRows.filter(row => row.parameter_key === "C23");
if (c23Rows.length !== 1) throw new Error(`expected exactly one C23 row, found ${c23Rows.length}`);
const c23 = c23Rows[0];
exact(Number(c23.new_value), expected.fteAnnualHours, "C23 value");
exact(c23.unit, "HOURS_PER_YEAR", "C23 unit");
if (!c23.approved_by || !c23.approved_at || !c23.activated_at)
  throw new Error("C23 approval/activation provenance is incomplete");

const c11Rows = parameterRows.filter(row => row.parameter_key === "C11");
if (c11Rows.length !== 1) throw new Error(`expected exactly one C11 row, found ${c11Rows.length}`);
const c11 = c11Rows[0];
exact(Number(c11.new_value), 0.5, "C11 value");
exact(c11.unit, "EUR_PER_HOUR", "C11 unit");
if (!c11.approved_by || !c11.approved_at || !c11.activated_at)
  throw new Error("C11 approval/activation provenance is incomplete");

const authoritative = selectLotAuthoritativeDocuments(
  documents,
  new Set([selectedEnrichmentLotId]),
  expected.lotKey,
);
if (!authoritative.length)
  throw new Error("no authoritative Munich documents survived exact-lot selection");

const facts = deriveCleaningRoomBookFacts(authoritative, expected.lotKey);
const annualArea = facts.find(fact => fact.key === "annual_cleaning_area_occurrences");
const sourceArea = facts.find(fact => fact.key === "areas");
const duration = facts.find(fact => fact.key === "contract_duration_months");

exact(annualArea?.value, expected.annualCleaningArea, "annual cleaning area");
exact(duration?.value, expected.contractMonths, "contract duration");
if (!annualArea?.evidence?.length || !duration?.evidence?.length)
  throw new Error("Munich area or duration provenance is incomplete");

const parameters = Object.fromEntries(
  parameterRows.map(row => [row.parameter_key, row.new_value]),
);
const units = Object.fromEntries(
  parameterRows.map(row => [row.parameter_key, row.unit]),
);
const approvalIdentity = "fe93f980-5699-44f4-ad41-69d254dcaa9f";
const scope = {
  tenantId: c23.tenant_id,
  companyId: expected.companyId,
  tenderId: expected.tenderId,
  lotId: metadata.lot.id,
  lotKey: expected.lotKey,
};
const exactLocation = evidence => {
  if (Number(evidence?.page) > 0) return {page: Number(evidence.page)};
  const worksheet = evidence?.worksheet ?? evidence?.table;
  const row = Number(evidence?.row ?? evidence?.firstIncludedRow);
  const rowStart = Number(evidence?.firstIncludedRow);
  const rowEnd = Number(evidence?.lastIncludedRow);
  const cell = evidence?.cell ?? evidence?.areaCell ?? evidence?.annualCell;
  return {
    ...(worksheet ? {worksheet} : {}),
    ...(Number.isInteger(row) && row > 0 ? {row} : {}),
    ...(Number.isInteger(rowStart) && rowStart > 0 && Number.isInteger(rowEnd) && rowEnd >= rowStart
      ? {rowStart, rowEnd} : {}),
    ...(cell ? {cell} : {}),
    ...(evidence?.columns ? {columns: evidence.columns} : {}),
  };
};
const documentEvidence = fact => (fact?.evidence || []).map(evidence => ({
  documentId: evidence.documentId,
  documentSha256: evidence.sha256 ?? evidence.hash,
  location: exactLocation(evidence),
}));
const evidenceFacts = [annualArea, sourceArea, duration].filter(Boolean);
const documentFingerprints = [...new Map(
  evidenceFacts.flatMap(fact => documentEvidence(fact)).map(evidence => [
    String(evidence.documentId),
    {documentId: evidence.documentId, sha256: evidence.documentSha256},
  ]),
).values()];
const parameterRecords = parameterRows.map(row => ({
  key: row.parameter_key,
  value: row.new_value,
  unit: row.unit,
  scope: {tenantId: row.tenant_id, companyId: expected.companyId, serviceArea: "cleaning"},
  source: "ACTIVE_APPROVED_EXACT_CONFIGURATION_SCOPE",
  versionId: row.version_id,
  approvedBy: row.approved_by,
  approvedAt: row.approved_at,
}));

// C22 is an explicitly approved value for this known Munich case only. It is
// deliberately never written to the clone or merged into the persisted rows.
const shadowC22 = expected.cleaningPerformance;
const productiveHours =
  annualArea.value / shadowC22 * duration.value / 12;
const round2 = value => Math.round((value + Number.EPSILON) * 100) / 100;
const workforce = {
  productiveHours: round2(productiveHours),
  annualHours: round2(productiveHours / duration.value * 12),
  monthlyHours: round2(productiveHours / duration.value),
  fte: round2(
    productiveHours /
      (Number(c23.new_value) * (duration.value / 12)),
  ),
};

exact(workforce.productiveHours, expected.productiveHours, "productive hours");
exact(workforce.annualHours, expected.annualHours, "annual hours");
exact(workforce.monthlyHours, expected.monthlyHours, "monthly hours");
exact(workforce.fte, expected.fte, "FTE");

const engineInput = {
  serviceArea: "cleaning",
  parameters,
  units,
  facts: {
    productiveHours,
    duration: duration.value,
    areas: sourceArea?.value ?? null,
  },
  provenance: {
    mode: "READ_ONLY_MUNICH_CLEANING_SHADOW",
    annualCleaningArea: {
      source: "VERIFIED_PROCUREMENT_DOCUMENT",
      value: annualArea.value,
      unit: annualArea.unit,
      evidence: annualArea.evidence,
    },
    contractDuration: {
      source: "VERIFIED_PROCUREMENT_DOCUMENT",
      value: duration.value,
      unit: duration.unit,
      evidence: duration.evidence,
    },
    cleaningPerformance: {
      source: "NONPERSISTENT_CASE_APPROVED_SHADOW_INPUT",
      parameterKey: "C22",
      value: shadowC22,
      unit: "M2_PER_HOUR",
      scope: {
        tenderId: expected.tenderId,
        companyId: expected.companyId,
        lotKey: expected.lotKey,
      },
    },
    workforceCapacity: {
      source: "ACTIVE_APPROVED_EXACT_CONFIGURATION_SCOPE",
      parameterKey: "C23",
      value: Number(c23.new_value),
      unit: c23.unit,
      versionId: c23.version_id,
      versionNo: c23.version_no,
      tenantId: c23.tenant_id,
      profileId: c23.profile_id,
      approvedBy: c23.approved_by,
      approvedAt: c23.approved_at,
      activatedAt: c23.activated_at,
    },
    externalWrite: false,
  },
};
const factRecords = [
  {key: "annualCleaningArea", value: annualArea.value, unit: annualArea.unit, scope,
    source: {type: "VERIFIED_PROCUREMENT_DOCUMENT_SET", evidence: documentEvidence(annualArea)}},
  {key: "duration", value: duration.value, unit: duration.unit, termType: "BASE", scope,
    source: {type: "VERIFIED_PROCUREMENT_DOCUMENT_SET", evidence: documentEvidence(duration)}},
  {key: "cleaningPerformance", value: shadowC22, unit: "M2_PER_HOUR", scope,
    source: {type: "EXPLICIT_MANAGEMENT_INPUT", inputId: "board-approval-2026-08-29-munich-c22", approvedBy: approvalIdentity, approvedAt: "2026-08-29"}},
  {key: "productiveHours", value: productiveHours, unit: "HOURS", scope,
    source: {type: "DETERMINISTIC_DERIVATION", ruleTypeId: "cleaning-area-hours", ruleVersion: 1,
      inputFactKeys: ["annualCleaningArea", "cleaningPerformance", "duration"]}},
];
if (sourceArea) factRecords.push({
  key: "areas", value: sourceArea.value, unit: sourceArea.unit, scope,
  source: {type: "VERIFIED_PROCUREMENT_DOCUMENT_SET", evidence: documentEvidence(sourceArea)},
});
const snapshot = createCalculationContractSnapshot({
  state: CALCULATION_CONTRACT_STATES.SHADOW,
  scope,
  engineInput,
  documentFingerprints,
  parameterRecords,
  factRecords,
  ruleTypes: [{
    id: "cleaning-area-hours", version: 1,
    gitCommit: "f862ceb69ee2ee73d3ba3af82c9bad5b7bbf73fc", status: "ACTIVE",
    testEvidence: "tests/isolated-munich-cleaning-shadow.test.mjs",
    shadowEvidence: "isolated-munich-cleaning-shadow",
    approvedBy: approvalIdentity,
  }],
});
const calculation = executeCalculationContractSnapshot(snapshot);

exact(
  calculation.status,
  "CALCULATION_PARTIAL",
  "calculation status",
);
exact(calculation.schemaVersion, 5, "calculation schema version");
exact(calculation.productiveHours, expected.productiveHours, "calculated productive hours");
exact(calculation.hoursPerYear, expected.annualHours, "calculated annual hours");
exact(calculation.hoursPerMonth, expected.monthlyHours, "calculated monthly hours");
exact(calculation.fteAnnualHours, expected.fteAnnualHours, "calculated C23");
exact(calculation.fte, expected.fte, "calculated FTE");
exact(calculation.material, expected.material, "calculated C11 material cost");
exact(calculation.totalPrice, expected.totalPrice, "calculated contract price");
exact(calculation.hourlyRate, expected.hourlyRate, "calculated hourly rate");
exact(calculation.annualPrice, expected.annualPrice, "calculated annual price");
if (calculation.unappliedConditionalCosts?.map(item => item.parameterKey).join(",") !== "C13,C14")
  throw new Error(`conditional cost disclosure mismatch: ${JSON.stringify(calculation.unappliedConditionalCosts)}`);
exact(calculation.externalTransmission, false, "external transmission");

const management = buildManagementOutput({
  tender: {
    buyer: metadata.tender.buyer,
    title: metadata.tender.title,
    offer_deadline: metadata.tender.offerDeadline,
  },
  lotKey: expected.lotKey,
  company: { sector_slug: "cleaning" },
  profileSnapshot: {
    id: c23.profile_id,
    revision: c23.version_no,
  },
  documentRevision: metadata.lot.enrichmentVersion,
  calculation,
  missing: [],
  jobId: null,
  correlationId: "read-only-munich-cleaning-shadow",
  now: metadata.shadowTimestamp,
});

exact(
  management.status,
  "MANAGEMENT_OUTPUT_GENERATED",
  "management status",
);
exact(
  management.recommendation?.decision,
  "MANAGEMENT_REVIEW_REQUIRED_PARTIAL",
  "management recommendation",
);
exact(management.externalTransmission, false, "management external transmission");

console.log(JSON.stringify({
  mode: "READ_ONLY_MUNICH_CLEANING_SHADOW",
  scope: {
    externalId: expected.externalId,
    tenderId: expected.tenderId,
    companyId: expected.companyId,
    lotKey: expected.lotKey,
    enrichmentVersionId: expected.enrichmentVersionId,
  },
  source: {
    inputDocuments: documents.length,
    authoritativeDocuments: authoritative.length,
    annualAreaEvidence: annualArea.evidence.map(item => ({
      documentId: item.documentId,
      filename: item.filename,
      sha256: item.sha256 ?? item.hash,
      worksheet: item.worksheet ?? item.table ?? null,
      includedRows: item.includedRows ?? null,
    })),
    durationEvidence: duration.evidence.map(item => ({
      documentId: item.documentId,
      filename: item.filename,
      sha256: item.sha256 ?? item.hash,
      page: item.page ?? null,
      start: item.start ?? null,
      end: item.end ?? item.endDates ?? null,
    })),
  },
  inputs: {
    annualCleaningArea: annualArea.value,
    annualCleaningAreaUnit: annualArea.unit,
    sourceArea: sourceArea?.value ?? null,
    sourceAreaUnit: sourceArea?.unit ?? null,
    contractMonths: duration.value,
    C22: shadowC22,
    C22Unit: "M2_PER_HOUR",
    C22Persistence: "NONE_CASE_SCOPED_SHADOW_ONLY",
    C23: Number(c23.new_value),
    C23Unit: c23.unit,
    C23Version: c23.version_no,
    C23ApprovedBy: c23.approved_by,
    C11: Number(c11.new_value),
    C11Unit: c11.unit,
    C11Version: c11.version_no,
    C11ApprovedBy: c11.approved_by,
  },
  calculation: {
    calculationContractVersion: calculation.calculationContractVersion,
    inputSnapshotSha256: calculation.inputSnapshotSha256,
    status: calculation.status,
    workforceStatus: "WORKFORCE_VALUES_VERIFIED",
    productiveHours: workforce.productiveHours,
    annualHours: workforce.annualHours,
    monthlyHours: workforce.monthlyHours,
    fte: workforce.fte,
    material: calculation.material,
    totalPrice: calculation.totalPrice,
    hourlyRate: calculation.hourlyRate,
    annualPrice: calculation.annualPrice,
    unappliedConditionalCosts: calculation.unappliedConditionalCosts,
    calculationHash: calculation.calculationHash,
    externalTransmission: calculation.externalTransmission,
  },
  inputSnapshot: {
    schemaVersion: snapshot.schemaVersion,
    contractVersion: snapshot.contractVersion,
    state: snapshot.state,
    sha256: snapshot.snapshotSha256,
  },
  management: {
    status: management.status,
    decision: management.recommendation.decision,
    outputHash: management.outputHash,
    externalTransmission: management.externalTransmission,
  },
  externalWrite: false,
}));
