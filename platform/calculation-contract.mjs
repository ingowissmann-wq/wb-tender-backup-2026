import {snapshotHash} from "./canonical-truth.mjs";
import {calculateSectorTender} from "./sector-calculation.mjs";

export const CALCULATION_CONTRACT_VERSION = "wb-tender-calculation-contract/1.0.0";
export const CANONICAL_FACT_MODEL_VERSION = "wb-tender-facts/1.0.0";
export const AI_EXTRACTION_INTERFACE_VERSION = "wb-tender-ai-extraction/1.0.0";
// Database snapshot schema versions 1-3 are historical formats. Version 4 is
// the first format whose hash covers the exact engine input and its evidence.
export const CALCULATION_INPUT_SNAPSHOT_SCHEMA_VERSION = 4;

export const CALCULATION_CONTRACT_STATES = Object.freeze({
  READY: "READY",
  SHADOW: "SHADOW",
  NEW_TENDER_TYPE_CANDIDATE: "NEW_TENDER_TYPE_CANDIDATE",
  QUARANTINED: "QUARANTINED",
});

const EXECUTABLE_STATES = new Set([
  CALCULATION_CONTRACT_STATES.READY,
  CALCULATION_CONTRACT_STATES.SHADOW,
]);
const DOCUMENT_SOURCE = "VERIFIED_PROCUREMENT_DOCUMENT";
const DOCUMENT_SET_SOURCE = "VERIFIED_PROCUREMENT_DOCUMENT_SET";
const MANAGEMENT_SOURCE = "EXPLICIT_MANAGEMENT_INPUT";
const DERIVATION_SOURCE = "DETERMINISTIC_DERIVATION";
const PARAMETER_SOURCE = "ACTIVE_APPROVED_EXACT_CONFIGURATION_SCOPE";
const SHA256 = /^[a-f0-9]{64}$/i;

const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
};
const immutable = value => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(immutable);
  return Object.freeze(value);
};
const supplied = value => value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");
const exactFactScope = (left = {}, right = {}) =>
  ["tenantId", "companyId", "tenderId", "lotId", "lotKey"]
    .every(key => !supplied(left[key]) || supplied(right[key]) && String(left[key]) === String(right[key]));
const hasExactLocator = location => Boolean(
  location && typeof location === "object" && (
    Number.isInteger(location.page) && location.page > 0 ||
    supplied(location.worksheet) && (
      Number.isInteger(location.row) && location.row > 0 ||
      supplied(location.cell) ||
      Number.isInteger(location.rowStart) && location.rowStart > 0 &&
        Number.isInteger(location.rowEnd) && location.rowEnd >= location.rowStart
    ) ||
    supplied(location.jsonPointer)
  )
);
const isRange = value => value && typeof value === "object" && !Array.isArray(value) && (
  supplied(value.minimum) || supplied(value.maximum) || supplied(value.min) || supplied(value.max)
);

const validateDocumentEvidence = ({evidence, fact, fingerprints, errors}) => {
  if (!Array.isArray(evidence) || !evidence.length) {
    errors.push({code: "FACT_DOCUMENT_EVIDENCE_EMPTY", fact});
    return;
  }
  for (const item of evidence) {
    if (!fingerprints.has(String(item?.documentId)))
      errors.push({code: "FACT_DOCUMENT_FINGERPRINT_MISSING", fact, documentId: item?.documentId || null});
    else if (fingerprints.get(String(item.documentId)) !== String(item.documentSha256 || "").toLowerCase())
      errors.push({code: "FACT_DOCUMENT_HASH_MISMATCH", fact, documentId: item.documentId});
    if (!hasExactLocator(item?.location))
      errors.push({code: "FACT_EXACT_LOCATION_MISSING", fact, documentId: item?.documentId || null});
  }
};

export function validateCalculationContractInput(input = {}) {
  const errors = [];
  const mode = input.mode || "PRODUCTION";
  const state = input.state || CALCULATION_CONTRACT_STATES.SHADOW;
  const scope = input.scope || {};
  const fingerprints = new Map();
  for (const document of input.documentFingerprints || []) {
    if (!supplied(document.documentId) || !SHA256.test(String(document.sha256 || ""))) {
      errors.push({code: "INVALID_DOCUMENT_FINGERPRINT", documentId: document.documentId || null});
      continue;
    }
    if (fingerprints.has(String(document.documentId)))
      errors.push({code: "DUPLICATE_DOCUMENT_FINGERPRINT", documentId: document.documentId});
    fingerprints.set(String(document.documentId), String(document.sha256).toLowerCase());
  }

  if (mode !== "MANUAL_SANDBOX") {
    for (const key of ["tenantId", "companyId", "tenderId"])
      if (!supplied(scope[key])) errors.push({code: "SCOPE_FIELD_MISSING", field: key});
  }
  if (!Object.values(CALCULATION_CONTRACT_STATES).includes(state))
    errors.push({code: "UNKNOWN_CONTRACT_STATE", state});

  const evidenceByKey = new Map();
  for (const record of input.factRecords || []) {
    const key = String(record?.key || "");
    if (!key) {
      errors.push({code: "FACT_KEY_MISSING"});
      continue;
    }
    if (evidenceByKey.has(key)) errors.push({code: "DUPLICATE_FACT_RECORD", fact: key});
    evidenceByKey.set(key, record);
    if (!exactFactScope(scope, record.scope || {})) errors.push({code: "CROSS_SCOPE_FACT", fact: key});
    if (!supplied(record.unit)) errors.push({code: "FACT_UNIT_MISSING", fact: key});
    if (isRange(record.value)) errors.push({code: "RANGE_REQUIRES_EXPLICIT_SELECTION", fact: key});
    if (key === "duration" && String(record.termType || "BASE").toUpperCase() === "OPTION")
      errors.push({code: "OPTION_TERM_CANNOT_BE_BASE_TERM", fact: key});

    const source = record.source || {};
    if (source.type === DOCUMENT_SOURCE) {
      validateDocumentEvidence({
        evidence: [{documentId: source.documentId, documentSha256: source.documentSha256, location: source.location}],
        fact: key,
        fingerprints,
        errors,
      });
    } else if (source.type === DOCUMENT_SET_SOURCE) {
      validateDocumentEvidence({evidence: source.evidence, fact: key, fingerprints, errors});
    } else if (source.type === MANAGEMENT_SOURCE) {
      if (![source.inputId, source.approvedBy, source.approvedAt].every(supplied))
        errors.push({code: "MANAGEMENT_APPROVAL_INCOMPLETE", fact: key});
    } else if (source.type === DERIVATION_SOURCE) {
      if (![source.ruleTypeId, source.ruleVersion].every(supplied) || !Array.isArray(source.inputFactKeys) || !source.inputFactKeys.length)
        errors.push({code: "DERIVATION_EVIDENCE_INCOMPLETE", fact: key});
    } else if (mode !== "MANUAL_SANDBOX") {
      errors.push({code: "FACT_SOURCE_NOT_AUTHORIZED", fact: key, sourceType: source.type || null});
    }
  }

  for (const [key, value] of Object.entries(input.engineInput?.facts || {})) {
    if (!supplied(value)) continue;
    const record = evidenceByKey.get(key);
    if (mode !== "MANUAL_SANDBOX" && !record) errors.push({code: "FACT_EVIDENCE_MISSING", fact: key});
    if (record && snapshotHash(stable(record.value)) !== snapshotHash(stable(value)))
      errors.push({code: "FACT_VALUE_EVIDENCE_MISMATCH", fact: key});
  }

  for (const rule of input.ruleTypes || []) {
    if (![rule?.id, rule?.version, rule?.gitCommit].every(supplied))
      errors.push({code: "RULE_VERSION_EVIDENCE_MISSING", ruleId: rule?.id || null});
    if (rule?.status === "ACTIVE" && ![rule.testEvidence, rule.shadowEvidence, rule.approvedBy].every(supplied))
      errors.push({code: "ACTIVE_RULE_RELEASE_EVIDENCE_MISSING", ruleId: rule?.id || null});
  }
  const rules = new Set((input.ruleTypes || []).map(rule => `${rule.id}:${rule.version}`));
  for (const record of input.factRecords || []) {
    if (record?.source?.type !== DERIVATION_SOURCE) continue;
    if (!rules.has(`${record.source.ruleTypeId}:${record.source.ruleVersion}`))
      errors.push({code: "DERIVATION_RULE_VERSION_MISSING", fact: record.key});
    for (const inputKey of record.source.inputFactKeys || [])
      if (!evidenceByKey.has(String(inputKey))) errors.push({code: "DERIVATION_INPUT_EVIDENCE_MISSING", fact: record.key, inputFact: inputKey});
  }

  const parameterRecords = new Map((input.parameterRecords || []).map(record => [String(record?.key || ""), record]));
  for (const [key, value] of Object.entries(input.engineInput?.parameters || {})) {
    if (!supplied(value) || mode === "MANUAL_SANDBOX") continue;
    const record = parameterRecords.get(key);
    if (!record) {
      errors.push({code: "PARAMETER_EVIDENCE_MISSING", parameterKey: key});
      continue;
    }
    if (record.source !== PARAMETER_SOURCE || ![record.versionId, record.approvedBy, record.approvedAt].every(supplied))
      errors.push({code: "PARAMETER_APPROVAL_INCOMPLETE", parameterKey: key});
    if (!supplied(record.scope?.tenantId) || String(record.scope.tenantId) !== String(scope.tenantId) ||
        !supplied(record.scope?.companyId) || String(record.scope.companyId) !== String(scope.companyId) ||
        !supplied(record.scope?.serviceArea) || String(record.scope.serviceArea) !== String(input.engineInput?.serviceArea))
      errors.push({code: "CROSS_SCOPE_PARAMETER", parameterKey: key});
    if (snapshotHash(stable(record.value)) !== snapshotHash(stable(value)))
      errors.push({code: "PARAMETER_VALUE_EVIDENCE_MISMATCH", parameterKey: key});
    const engineUnit = input.engineInput?.units?.[key];
    if (supplied(engineUnit) && String(record.unit || "").toUpperCase() !== String(engineUnit).toUpperCase())
      errors.push({code: "PARAMETER_UNIT_EVIDENCE_MISMATCH", parameterKey: key});
  }
  return immutable({valid: errors.length === 0, errors});
}

export function createCalculationContractSnapshot(input = {}) {
  const validation = validateCalculationContractInput(input);
  if (!validation.valid) {
    const error = new Error("CALCULATION_CONTRACT_INVALID");
    error.code = "CALCULATION_CONTRACT_INVALID";
    error.details = validation.errors;
    throw error;
  }
  const body = stable({
    schemaVersion: CALCULATION_INPUT_SNAPSHOT_SCHEMA_VERSION,
    contractVersion: CALCULATION_CONTRACT_VERSION,
    factModelVersion: CANONICAL_FACT_MODEL_VERSION,
    state: input.state || CALCULATION_CONTRACT_STATES.SHADOW,
    mode: input.mode || "PRODUCTION",
    scope: input.scope || {},
    engineInput: input.engineInput || {},
    factRecords: input.factRecords || [],
    parameterRecords: input.parameterRecords || [],
    documentFingerprints: input.documentFingerprints || [],
    ruleTypes: input.ruleTypes || [],
  });
  return immutable({...body, snapshotSha256: snapshotHash(body)});
}

export function executeCalculationContractSnapshot(snapshot) {
  const {snapshotSha256, ...body} = snapshot || {};
  if (!SHA256.test(String(snapshotSha256 || "")) || snapshotHash(body) !== snapshotSha256)
    throw Object.assign(new Error("CALCULATION_INPUT_SNAPSHOT_HASH_MISMATCH"), {code: "CALCULATION_INPUT_SNAPSHOT_HASH_MISMATCH"});
  if (!EXECUTABLE_STATES.has(snapshot.state))
    throw Object.assign(new Error("CALCULATION_CONTRACT_STATE_NOT_EXECUTABLE"), {code: "CALCULATION_CONTRACT_STATE_NOT_EXECUTABLE", state: snapshot.state});
  const result = calculateSectorTender(snapshot.engineInput);
  return immutable({...result, calculationContractVersion: snapshot.contractVersion, inputSnapshotSha256: snapshotSha256});
}

export function createAiExtractionCandidate({scope = {}, documentFingerprint, candidates = [], proposedRuleTypes = []} = {}) {
  const body = stable({
    interfaceVersion: AI_EXTRACTION_INTERFACE_VERSION,
    status: CALCULATION_CONTRACT_STATES.NEW_TENDER_TYPE_CANDIDATE,
    scope,
    documentFingerprint,
    candidates,
    proposedRuleTypes,
    executable: false,
    persistedAsProductionFact: false,
    externalTransmission: false,
    documentInstructionsTrusted: false,
  });
  return immutable({...body, candidateSnapshotSha256: snapshotHash(body)});
}
