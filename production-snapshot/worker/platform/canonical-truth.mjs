import crypto from "node:crypto";

export const PIPELINE_SCHEMA_VERSION = "wb-tender-pipeline/5.0.0";
export const PIPELINE_STEPS = Object.freeze([
  "SOURCE_RESOLVED", "TARGET_PORTAL_RESOLVED", "AUTHENTICATED",
  "DOCUMENT_LIST_RESOLVED", "PROCUREMENT_DOCUMENTS_VERIFIED",
  "DOCUMENTS_ANALYZED", "ENRICHMENT_MATERIALIZED", "EFFECTIVE_PROFILE_RESOLVED",
  "CAPACITY_EVALUATED", "INPUT_COMPLETENESS_CHECKED", "CALCULATION_QUEUED",
  "CALCULATION_COMPLETED", "MANAGEMENT_OUTPUT_GENERATED", "BOARD_BRIEF_GENERATED"
]);

export const BLOCKING_STATES = Object.freeze(new Set([
  "UNKNOWN_PORTAL_ADAPTER_REQUIRED", "ADAPTER_REPAIR_REQUIRED", "CREDENTIAL_REQUIRED",
  "MFA_REQUIRED", "CAPTCHA_REQUIRED", "TEMPORARILY_UNAVAILABLE",
  "DOCUMENT_LIST_NOT_RESOLVED", "PROCUREMENT_DOCUMENTS_NOT_VERIFIED",
  "DOCUMENT_ANALYSIS_FAILED", "EFFECTIVE_PROFILE_MISSING",
  "CAPACITY_INPUT_MISSING", "CALCULATION_INPUT_MISSING",
  "CALCULATION_TECHNICAL_ERROR", "RISK_EVIDENCE_INSUFFICIENT"
]));

const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
};
export const snapshotHash = value => crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
export const jobIdempotencyKey = ({tenderId, lotKey, companyId, profileSnapshotId, documentRevision, calculationVersion, pipelineVersion = PIPELINE_SCHEMA_VERSION, step}) =>
  [tenderId, lotKey || "_tender", companyId, profileSnapshotId || "_profile", documentRevision || "_document", calculationVersion || "_calculation", pipelineVersion, step].map(String).join(":");

export const DECLARED_PROFILE_STATUSES = Object.freeze(new Set([
  "PROVIDED", "VERIFIED", "NONE_DECLARED", "NOT_APPLICABLE", "NOT_REQUIRED"
]));

export function isExplicitlySupplied(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && typeof value.status === "string")
    return DECLARED_PROFILE_STATUSES.has(value.status.toUpperCase()) || !["MISSING", "EXPIRED", "PENDING_VERIFICATION"].includes(value.status.toUpperCase());
  return true;
}

export function classifyNoticeType(value = {}) {
  const searchable = JSON.stringify(value).toLowerCase();
  if (/contractawardnotice|contract award notice|zuschlagsbekanntmach|vergebene auftr[aä]ge/.test(searchable)) return "AWARD_NOTICE";
  if (/competitionnotice|contractnotice|priorinformationnotice|auftragsbekanntmach|vergabebekanntmach/.test(searchable)) return "ACTIVE_PROCUREMENT_NOTICE";
  return "UNKNOWN_NOTICE";
}

export function nextPipelineTransition({completedSteps = [], blockingState = null} = {}) {
  if (blockingState) return {status: "BLOCKED", blockingState, nextStep: null, fachlichCompleted: false};
  const done = new Set(completedSteps);
  const nextStep = PIPELINE_STEPS.find(step => !done.has(step)) || null;
  return nextStep
    ? {status: "IN_PROGRESS", blockingState: null, nextStep, fachlichCompleted: false}
    : {status: "FACHLICH_COMPLETED", blockingState: null, nextStep: null, fachlichCompleted: true};
}

const GENERAL_DOCUMENT = /(?:^|[\s_.-])(agb|allgemeine gesch[aä]ftsbedingungen|datenschutz|privacy|hilfe|help|login|landing|nutzungsbedingungen|impressum)(?:[\s_.-]|$)/i;
const PROCUREMENT_DOCUMENT = /(?:bekanntmachung|vergabeunterlag|aufforderung|formblatt|eignung|leistungsverzeichnis|leistung(?:sbeschreibung)?|preisblatt|angebotspreis|vertrag|anlage|anhang|los(?:unterlag)?|specification|bill.of.quantit|boq|tender.document)/i;
const PROCUREMENT_CLASSES = Object.freeze(new Set(["NOTICE", "PROCUREMENT_DOCUMENTS", "SPECIFICATION", "PRICE_SHEET", "CONTRACT", "ANNEX", "LOT_DOCUMENTS"]));

export function classifyProcurementDocument({filename = "", title = "", extractedText = "", mimeType = "", magicBytesValid = false, size = 0, hash = "", tenderLinked = false, lotLinked = false, tenderGlobal = false} = {}) {
  // Procurement packages frequently place the LV behind cover sheets and bidder
  // instructions. Keep a bounded payload, but do not truncate before later pages.
  const searchable = `${filename} ${title} ${String(extractedText).slice(0, 250_000)}`;
  let documentClass = "OTHER";
  if (PROCUREMENT_DOCUMENT.test(filename)) documentClass = "PROCUREMENT_DOCUMENTS";
  else if (GENERAL_DOCUMENT.test(searchable)) documentClass = "GENERAL_PORTAL_DOCUMENT";
  else if (/preisblatt|angebotspreis|price.sheet|stundens[aä]tz|preis(?:-|\s*)und(?:-|\s*)stunden(?:-|\s*)[uü]bersicht/i.test(searchable)) documentClass = "PRICE_SHEET";
  else if (/leistungsverzeichnis|leistungsbeschreibung|specification|bill.of.quantit|boq|unterhaltsreinigung|grundreinigung|sonderreinigung|reinigungsplan|reinigungsmatrix|fl[aä]chenverzeichnis|raumverzeichnis|mengenger[uü]st/i.test(searchable)) documentClass = "SPECIFICATION";
  else if (/vertrag/i.test(searchable)) documentClass = "CONTRACT";
  else if (/bekanntmachung|notice/i.test(searchable)) documentClass = "NOTICE";
  else if (/\blos\b|lot.document/i.test(searchable)) documentClass = "LOT_DOCUMENTS";
  else if (/anlage|anhang|annex/i.test(searchable)) documentClass = "ANNEX";
  else if (PROCUREMENT_DOCUMENT.test(searchable)) documentClass = "PROCUREMENT_DOCUMENTS";
  else if (mimeType === "application/zip" && tenderLinked && (lotLinked || tenderGlobal)) documentClass = "PROCUREMENT_DOCUMENTS";
  const scopeVerified=lotLinked||tenderGlobal||documentClass==="NOTICE",verified=Boolean(PROCUREMENT_CLASSES.has(documentClass)&&magicBytesValid&&size>=64&&/^[a-f0-9]{64}$/i.test(hash)&&tenderLinked&&scopeVerified);
  return {documentClass,procurementRelevant:PROCUREMENT_CLASSES.has(documentClass),verified,rejectionReason:verified?null:documentClass==="GENERAL_PORTAL_DOCUMENT"?"GENERAL_PORTAL_DOCUMENT":!magicBytesValid?"MAGIC_BYTES_INVALID":size<64?"DOCUMENT_TOO_SMALL":!tenderLinked?"TENDER_ASSOCIATION_MISSING":!scopeVerified?"LOT_ASSOCIATION_MISSING":!/^[a-f0-9]{64}$/i.test(hash)?"HASH_MISSING":"PROCUREMENT_CLASS_NOT_PROVEN",mimeType};
}

export function tenderDocumentOutcome({documents = [], structuredNoDocuments = false, structuredResponseEvidence = null} = {}) {
  const verified = documents.filter(document => document.classification?.verified === true);
  if (verified.length) return {status: "PROCUREMENT_DOCUMENTS_VERIFIED", succeeded: true, verifiedCount: verified.length};
  if (structuredNoDocuments && structuredResponseEvidence) return {status: "NO_PROCUREMENT_DOCUMENTS_CONFIRMED", succeeded: true, verifiedCount: 0};
  return {status: "PROCUREMENT_DOCUMENTS_NOT_VERIFIED", succeeded: false, verifiedCount: 0};
}

const portalFailures = new Set(["LOGIN_FORMULAR_GEAENDERT", "LOGIN_REDIRECT_UNERWARTET", "ADAPTER_REPAIR_REQUIRED"]);
export function effectivePortalStatus({adapterValidated = false, liveResult = null, credentialsPresent = false, documentFetchPossible = false, mfaRequired = false, captchaRequired = false, temporarilyUnavailable = false, adapterKnown = true} = {}) {
  if (!adapterKnown) return "UNKNOWN_PORTAL_ADAPTER_REQUIRED";
  if (mfaRequired) return "MFA_REQUIRED";
  if (captchaRequired) return "CAPTCHA_REQUIRED";
  if (!credentialsPresent) return "CREDENTIAL_REQUIRED";
  if (temporarilyUnavailable) return "TEMPORARILY_UNAVAILABLE";
  if (portalFailures.has(liveResult)) return adapterValidated ? "ADAPTER_VALIDATED_BUT_DEGRADED" : "ADAPTER_REPAIR_REQUIRED";
  if (adapterValidated && liveResult === "LOGIN_SUCCEEDED" && documentFetchPossible) return "LIVE_VALIDATED";
  if (adapterValidated) return "ADAPTER_VALIDATED_BUT_DEGRADED";
  return "ADAPTER_REPAIR_REQUIRED";
}

const PORTAL_FAMILY_ALIASES = Object.freeze([
  {key:"deutsche-evergabe",pattern:/(?:^|\.)deutsche-evergabe\.de$/},
  {key:"vergabe24",pattern:/(?:^|\.)vergabe24\.de$/},
  {key:"dtvp",pattern:/(?:^|\.)(?:dtvp\.de|deutsche-evergabe\.com)$/},
  {key:"meinauftrag",pattern:/(?:^|\.)meinauftrag\.rib\.de$/}
]);
export function portalFamilyKey(domain, adapterId = null) {
  const host=String(domain||"").trim().toLowerCase().replace(/\.$/,"");
  const alias=PORTAL_FAMILY_ALIASES.find(item=>item.pattern.test(host));
  if(alias)return alias.key;
  if(adapterId&&!/^unknown|generic/i.test(adapterId))return String(adapterId).toLowerCase();
  const labels=host.split(".");return labels.length>2?labels.slice(-2).join("."):host;
}

export function resolveEffectiveParameters(rows, {asOf = new Date()} = {}) {
  const point = new Date(asOf).getTime(), grouped = new Map();
  for (const row of rows) {
    const from = row.valid_from ? new Date(row.valid_from).getTime() : -Infinity;
    const until = row.valid_until ? new Date(row.valid_until).getTime() : Infinity;
    if (row.status !== "ACTIVE" || from > point || until < point) continue;
    const key = `${row.company_id}:${row.service_line}:${row.parameter_key}`;
    const values = grouped.get(key) || []; values.push(row); grouped.set(key, values);
  }
  const parameters = {}, ambiguities = [];
  for (const [key, candidates] of grouped) {
    candidates.sort((a, b) => Number(b.version_no || 0) - Number(a.version_no || 0) || new Date(b.activated_at || b.created_at || 0) - new Date(a.activated_at || a.created_at || 0) || String(b.id).localeCompare(String(a.id)));
    const winner = candidates[0];
    if (candidates.length > 1 && Number(candidates[0].version_no || 0) === Number(candidates[1].version_no || 0)) ambiguities.push({key, candidateIds: candidates.map(x => x.id)});
    parameters[winner.parameter_key] = {value: winner.new_value, parameterId: winner.id, sourceVersionId: winner.version_id, sourceVersion: winner.version_no, validFrom: winner.valid_from || null, validUntil: winner.valid_until || null, activatedAt: winner.activated_at || null};
  }
  const revision = snapshotHash({parameters, ambiguities});
  const snapshot = {asOf: new Date(asOf).toISOString(), revision, parameters, ambiguities};
  return {...snapshot, snapshotId: revision};
}

export function buildCalculationInput({profileSnapshot, tenderFields = [], requiredFields = []} = {}) {
  const values = {}, provenance = {}, missing = [];
  for (const [key, item] of Object.entries(profileSnapshot?.parameters || {})) { values[key] = item.value; provenance[key] = {source: "COMPANY_PROFILE", snapshotId: profileSnapshot.snapshotId, parameterId: item.parameterId, sourceVersionId: item.sourceVersionId}; }
  for (const item of tenderFields) if (item?.key && isExplicitlySupplied(item.value)) { values[item.key] = item.value; provenance[item.key] = {source: "TENDER_DOCUMENT", documentId: item.documentId, page: item.page, table: item.table, cell: item.cell, hash: item.hash}; }
  for (const requirement of requiredFields) if (!isExplicitlySupplied(values[requirement.key])) missing.push({field: requirement.key, category: requirement.source === "profile" ? "MISSING_COMPANY_PARAMETER" : "MISSING_TENDER_INFORMATION", source: requirement.source, requiredFor: requirement.requiredFor || "CALCULATION"});
  if (profileSnapshot?.ambiguities?.length) for (const ambiguity of profileSnapshot.ambiguities) missing.push({field: ambiguity.key.split(":").at(-1), category: "AMBIGUOUS_PROFILE_MAPPING", source: "profile", candidateIds: ambiguity.candidateIds});
  const body = {schemaVersion: 1, profileSnapshotId: profileSnapshot?.snapshotId || null, values, provenance, missing};
  return {...body, snapshotId: snapshotHash(body)};
}

export function guardedRecommendation({eligibility = "UNKNOWN", capacity = "UNKNOWN", calculation = "UNKNOWN", risks = [], mandatoryEvidenceMissing = [], hardNo = false} = {}) {
  if (hardNo) return {decision: "NO_GO_REQUIRED", reasonCode: "HARD_NO_GATE"};
  if (mandatoryEvidenceMissing.length) return {decision: "BOARD_DECISION_REQUIRED", reasonCode: "MANDATORY_EVIDENCE_MISSING"};
  if (eligibility !== "PASSED") return {decision: "BOARD_DECISION_REQUIRED", reasonCode: "ELIGIBILITY_NOT_PROVEN"};
  if (capacity !== "PASSED") return {decision: "BOARD_DECISION_REQUIRED", reasonCode: "CAPACITY_NOT_PROVEN"};
  if (calculation !== "COMPLETED") return {decision: "BOARD_DECISION_REQUIRED", reasonCode: "CALCULATION_NOT_COMPLETED"};
  if (!risks.length || risks.some(risk => !["EVALUATED", "ACCEPTED", "MITIGATED"].includes(risk.status))) return {decision: "BOARD_DECISION_REQUIRED", reasonCode: "RISKS_NOT_PROVEN"};
  const conditions = risks.filter(risk => risk.status === "MITIGATED" && risk.condition?.measurable && risk.condition?.bounded && !risk.condition?.economicallyDecisive);
  return conditions.length === risks.filter(risk => risk.status === "MITIGATED").length && conditions.length
    ? {decision: "GO_UNTER_BEDINGUNGEN", reasonCode: "BOUNDED_CONDITIONS", conditions: conditions.map(risk => risk.condition)}
    : {decision: "GO", reasonCode: "ALL_GATES_PASSED"};
}
