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
import {createGroupedPerformanceDecision} from "../platform/grouped-performance.mjs";

const [documentsPath, parametersPath, metadataPath, selectedEnrichmentLotId] = process.argv.slice(2);
if (!documentsPath || !parametersPath || !metadataPath || !selectedEnrichmentLotId)
  throw new Error("usage: isolated-blka-cleaning-shadow.mjs DOCUMENTS_JSON PARAMETERS_JSON METADATA_JSON SELECTED_ENRICHMENT_LOT_ID");

const [documents, parameterRows, metadata] = await Promise.all([
  fs.readFile(documentsPath, "utf8").then(JSON.parse),
  fs.readFile(parametersPath, "utf8").then(JSON.parse),
  fs.readFile(metadataPath, "utf8").then(JSON.parse),
]);

const expected = Object.freeze({
  externalId: "514707-2026",
  tenderId: "06e91129-00c0-4820-9fbe-087e3517ce80",
  companyId: "15c3c602-aa51-4dd4-adc1-3586dc82e523",
  lotId: "50479867-5774-4db4-bdef-b93a7d0eb88f",
  lotKey: "LOT-0001",
  enrichmentVersionId: "5e885f85-c63e-47c8-ac5e-ab6770f9d446",
  annualCleaningArea: 2589414.889362,
  sourceArea: 29142.6877,
  contractMonths: 24,
  maximumContractMonths: 60,
  annualHours: 14011.83,
  productiveHours: 28023.66,
  monthlyHours: 1167.65,
  fteAnnualHours: 1670,
  fte: 8.39,
  calculationHash: "25d800040ceaee1601a2639635f48bc26ab8e371a5629b228c84a9d73dc2c9bc",
});

const approvedPerformance = Object.freeze({ A: 195, B: 160, C: 75, D: 310 });
const round2 = value => Math.round((value + Number.EPSILON) * 100) / 100;
const exact = (actual, wanted, label) => {
  if (actual !== wanted)
    throw new Error(`${label} mismatch: expected=${wanted} actual=${actual}`);
};

exact(metadata?.tender?.externalId, expected.externalId, "external tender id");
exact(metadata?.tender?.id, expected.tenderId, "tender id");
exact(metadata?.company?.id, expected.companyId, "company id");
exact(metadata?.lot?.id, expected.lotId, "lot id");
exact(metadata?.lot?.key, expected.lotKey, "lot key");
exact(metadata?.lot?.enrichmentVersionId, expected.enrichmentVersionId, "enrichment version id");

if (!Array.isArray(documents) || documents.length < 55)
  throw new Error(`verified BLKA document set is incomplete: ${documents?.length ?? "invalid"}`);
if (documents.some(document => document.procurement_verification_status !== "VERIFIED"))
  throw new Error("unverified document entered BLKA shadow set");
if (!Array.isArray(parameterRows) || !parameterRows.length)
  throw new Error("active exact-scope Cleaning parameters are empty");
if (parameterRows.some(row => row.parameter_key === "C22"))
  throw new Error("C22 must not be persisted for the grouped BLKA shadow replay");

const approvedParameter = (key, value, unit) => {
  const rows = parameterRows.filter(row => row.parameter_key === key);
  if (rows.length !== 1) throw new Error(`expected exactly one ${key} row, found ${rows.length}`);
  const row = rows[0];
  exact(Number(row.new_value), value, `${key} value`);
  exact(row.unit, unit, `${key} unit`);
  if (!row.approved_by || !row.approved_at || !row.activated_at)
    throw new Error(`${key} approval/activation provenance is incomplete`);
  return row;
};
const c23 = approvedParameter("C23", 1670, "HOURS_PER_YEAR");
const c11 = approvedParameter("C11", 0.5, "EUR_PER_HOUR");

const authoritative = selectLotAuthoritativeDocuments(
  documents,
  new Set([selectedEnrichmentLotId]),
  expected.lotKey,
);
if (!authoritative.length) throw new Error("no authoritative BLKA documents survived exact-lot selection");

const facts = deriveCleaningRoomBookFacts(authoritative, expected.lotKey);
const annualArea = facts.find(fact => fact.key === "annual_cleaning_area_occurrences");
const sourceArea = facts.find(fact => fact.key === "areas");
const groupArea = facts.find(fact => fact.key === "annual_cleaning_area_by_group");
const duration = facts.find(fact => fact.key === "contract_duration_months");
const maximumDuration = facts.find(fact => fact.key === "contract_maximum_duration_months");

exact(annualArea?.value, expected.annualCleaningArea, "annual cleaning area");
exact(sourceArea?.value, expected.sourceArea, "source area");
exact(duration?.value, expected.contractMonths, "base contract duration");
exact(maximumDuration?.value, expected.maximumContractMonths, "maximum option duration");
if (!annualArea?.evidence?.length || !duration?.evidence?.length || !groupArea?.evidence?.length)
  throw new Error("BLKA area, group or duration provenance is incomplete");

const groupRows = groupArea.value.map(row => {
  const performanceGroup = String(row.group).match(/^([A-Z])(?:\/\d+)?$/)?.[1] ?? null;
  const performance = approvedPerformance[performanceGroup];
  if (!performance) throw new Error(`no approved grouped performance for ${row.group}`);
  return {
    ...row,
    performanceGroup,
    performance,
    annualHours: row.annualCleaningArea / performance,
  };
});
const annualHoursRaw = groupRows.reduce((sum, row) => sum + row.annualHours, 0);
const productiveHoursRaw = annualHoursRaw * duration.value / 12;
const workforce = {
  productiveHours: round2(productiveHoursRaw),
  annualHours: round2(annualHoursRaw),
  monthlyHours: round2(annualHoursRaw / 12),
  fte: round2(annualHoursRaw / Number(c23.new_value)),
};
exact(workforce.productiveHours, expected.productiveHours, "productive hours");
exact(workforce.annualHours, expected.annualHours, "annual hours");
exact(workforce.monthlyHours, expected.monthlyHours, "monthly hours");
exact(workforce.fte, expected.fte, "FTE");

const parameters = Object.fromEntries(parameterRows.map(row => [row.parameter_key, row.new_value]));
const units = Object.fromEntries(parameterRows.map(row => [row.parameter_key, row.unit]));
const approvalIdentity = "fe93f980-5699-44f4-ad41-69d254dcaa9f";
const scope = {
  tenantId: c23.tenant_id,
  companyId: expected.companyId,
  tenderId: expected.tenderId,
  lotId: expected.lotId,
  lotKey: expected.lotKey,
};
const groupedPerformanceDecision = createGroupedPerformanceDecision({
  scope,
  defaultPerformance: null,
  groups: Object.entries(approvedPerformance).map(([groupKey, approvedPerformanceValue]) => ({
    groupKey,
    minimumPerformance: null,
    approvedPerformance: approvedPerformanceValue,
    maximumPerformance: null,
    unit: "M2_PER_HOUR",
    priority: 100,
    classification: "CASE_APPROVED",
  })),
  applications: groupRows.map(row => ({subgroupKey: row.group, groupKey: row.performanceGroup})),
  approval: {
    inputId: "board-approval-2026-08-29-blka-lot-0001-c22-grouped",
    approvedBy: approvalIdentity,
    approvedAt: "2026-08-29",
  },
});
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
const evidenceFacts = [annualArea, sourceArea, duration];
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
  classification: "COMPANY_APPROVED",
  scope: {tenantId: row.tenant_id, companyId: expected.companyId, serviceArea: "cleaning"},
  source: "ACTIVE_APPROVED_EXACT_CONFIGURATION_SCOPE",
  versionId: row.version_id,
  approvedBy: row.approved_by,
  approvedAt: row.approved_at,
}));
const groupedPerformanceProvenance = {
  source: "NONPERSISTENT_CASE_APPROVED_GROUPED_SHADOW_INPUT",
  parameterContract: "C22_GROUPED",
  values: approvedPerformance,
  unit: "M2_PER_HOUR",
  approval: "Vorstandsfreigabe Dr. Ingo Wissmann vom 29.08.2026",
  scope: {
    tenderId: expected.tenderId,
    companyId: expected.companyId,
    lotKey: expected.lotKey,
  },
};

const engineInput = {
  serviceArea: "cleaning",
  parameters,
  units,
  facts: {
    productiveHours: productiveHoursRaw,
    duration: duration.value,
    areas: sourceArea.value,
  },
  provenance: {
    mode: "READ_ONLY_BLKA_GROUPED_CLEANING_SHADOW",
    annualCleaningArea: {
      source: "VERIFIED_PROCUREMENT_DOCUMENT",
      value: annualArea.value,
      unit: annualArea.unit,
      evidence: annualArea.evidence,
    },
    contractDuration: {
      source: "VERIFIED_BASE_TERM_EXCLUDING_OPTIONS",
      value: duration.value,
      unit: duration.unit,
      maximumOptionMonths: maximumDuration.value,
      evidence: duration.evidence,
    },
    groupedCleaningPerformance: groupedPerformanceProvenance,
    workforceCapacity: {
      source: "ACTIVE_APPROVED_EXACT_CONFIGURATION_SCOPE",
      parameterKey: "C23",
      value: Number(c23.new_value),
      unit: c23.unit,
      versionId: c23.version_id,
      versionNo: c23.version_no,
      approvedBy: c23.approved_by,
      approvedAt: c23.approved_at,
      activatedAt: c23.activated_at,
    },
    externalWrite: false,
  },
};
const snapshot = createCalculationContractSnapshot({
  state: CALCULATION_CONTRACT_STATES.SHADOW,
  scope,
  engineInput,
  documentFingerprints,
  parameterRecords,
  factRecords: [
    {key: "annualCleaningArea", value: annualArea.value, unit: annualArea.unit, scope, classification: "DOCUMENT_VERIFIED",
      source: {type: "VERIFIED_PROCUREMENT_DOCUMENT_SET", evidence: documentEvidence(annualArea)}},
    {key: "areas", value: sourceArea.value, unit: sourceArea.unit, scope, classification: "DOCUMENT_VERIFIED",
      source: {type: "VERIFIED_PROCUREMENT_DOCUMENT_SET", evidence: documentEvidence(sourceArea)}},
    {key: "duration", value: duration.value, unit: duration.unit, termType: "BASE", scope, classification: "DOCUMENT_VERIFIED",
      source: {type: "VERIFIED_PROCUREMENT_DOCUMENT_SET", evidence: documentEvidence(duration)}},
    {key: "groupedCleaningPerformance", value: groupedPerformanceDecision, unit: "M2_PER_HOUR_BY_GROUP", scope, classification: "CASE_APPROVED",
      source: {type: "EXPLICIT_MANAGEMENT_INPUT", inputId: "board-approval-2026-08-29-blka-lot-0001-c22-grouped", approvedBy: approvalIdentity, approvedAt: "2026-08-29"}},
    {key: "productiveHours", value: productiveHoursRaw, unit: "HOURS", scope, classification: "DETERMINISTIC_DERIVED",
      source: {type: "DETERMINISTIC_DERIVATION", ruleTypeId: "cleaning-grouped-area-hours", ruleVersion: 1,
        inputFactKeys: ["annualCleaningArea", "groupedCleaningPerformance", "duration"]}},
  ],
  ruleTypes: [{
    id: "cleaning-grouped-area-hours", version: 1,
    gitCommit: "f862ceb69ee2ee73d3ba3af82c9bad5b7bbf73fc", status: "ACTIVE",
    testEvidence: "tests/cleaning-grouped-performance.test.mjs",
    shadowEvidence: "isolated-blka-grouped-approved-shadow",
    approvedBy: approvalIdentity,
  }],
});
const calculation = executeCalculationContractSnapshot(snapshot);

exact(calculation.schemaVersion, 5, "calculation schema version");
exact(calculation.status, "CALCULATION_PARTIAL", "calculation status");
exact(calculation.productiveHours, expected.productiveHours, "calculated productive hours");
exact(calculation.hoursPerYear, expected.annualHours, "calculated annual hours");
exact(calculation.hoursPerMonth, expected.monthlyHours, "calculated monthly hours");
exact(calculation.fteAnnualHours, expected.fteAnnualHours, "calculated C23");
exact(calculation.fte, expected.fte, "calculated FTE");
exact(calculation.material, round2(productiveHoursRaw * 0.5), "calculated C11 material cost");
if (calculation.unappliedConditionalCosts?.map(item => item.parameterKey).join(",") !== "C13,C14")
  throw new Error(`conditional cost disclosure mismatch: ${JSON.stringify(calculation.unappliedConditionalCosts)}`);
exact(calculation.externalTransmission, false, "external transmission");
exact(calculation.calculationHash, expected.calculationHash, "calculation hash");

const management = buildManagementOutput({
  tender: {
    buyer: metadata.tender.buyer,
    title: metadata.tender.title,
    offer_deadline: metadata.tender.offerDeadline,
  },
  lotKey: expected.lotKey,
  company: { sector_slug: "cleaning" },
  profileSnapshot: { id: c23.profile_id, revision: c23.version_no },
  documentRevision: metadata.lot.enrichmentVersion,
  calculation,
  missing: [],
  jobId: null,
  correlationId: "read-only-blka-grouped-cleaning-shadow",
  now: metadata.shadowTimestamp,
});
exact(management.status, "MANAGEMENT_OUTPUT_GENERATED", "management status");
exact(management.recommendation?.decision, "MANAGEMENT_REVIEW_REQUIRED_PARTIAL", "management recommendation");
exact(management.externalTransmission, false, "management external transmission");

console.log(JSON.stringify({
  mode: "READ_ONLY_BLKA_GROUPED_CLEANING_SHADOW",
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
    annualCleaningArea: annualArea.value,
    sourceArea: sourceArea.value,
    baseContractMonths: duration.value,
    maximumOptionMonths: maximumDuration.value,
    areaEvidence: annualArea.evidence,
    durationEvidence: duration.evidence,
  },
  inputs: {
    groupedPerformance: approvedPerformance,
    groupedPerformanceDecision,
    groupedPerformanceUnit: "M2_PER_HOUR",
    groupedPerformancePersistence: "NONE_CASE_SCOPED_SHADOW_ONLY",
    groupRows: groupRows.map(row => ({
      group: row.group,
      performanceGroup: row.performanceGroup,
      annualCleaningArea: row.annualCleaningArea,
      performance: row.performance,
      annualHours: round2(row.annualHours),
    })),
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
    productiveHours: calculation.productiveHours,
    annualHours: calculation.hoursPerYear,
    monthlyHours: calculation.hoursPerMonth,
    fte: calculation.fte,
    materialContract: calculation.material,
    totalPrice: calculation.totalPrice,
    hourlyRate: calculation.hourlyRate,
    monthlyPrice: calculation.monthlyPrice,
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
