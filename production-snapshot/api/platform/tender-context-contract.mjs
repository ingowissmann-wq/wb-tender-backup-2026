import { PORTAL_ACCESS_STATUSES } from "./canonical-portal-access.mjs";

export const TENDER_CONTEXT_SCHEMA_VERSION = "wb-tender-context/1.0.0";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_FIELDS = new Set([
  "tenant_id",
  "company_id",
  "tender_id",
  "tender_version_id",
  "lot_id",
  "enrichment_lot_id",
  "enrichment_version_id",
  "document_portal_id",
  "submission_portal_id",
  "credential_scope_id",
  "region_version_id",
]);
const PORTAL_STATUSES = new Set(PORTAL_ACCESS_STATUSES);

export const TENDER_CONTEXT_FIELDS = Object.freeze({
  tenant_id: Object.freeze({ producer: "authoritative tenant/company binding", nullable: false }),
  company_id: Object.freeze({ producer: "authoritative company scope", nullable: false }),
  tender_id: Object.freeze({ producer: "tender import", nullable: false }),
  tender_version_id: Object.freeze({ producer: "current tender version", nullable: false }),
  lot_id: Object.freeze({ producer: "tender.lots", nullable: true, note: "Canonical tender.lots UUID; never a tender.enrichment_lots UUID." }),
  lot_key: Object.freeze({ producer: "authoritative source lot reference", nullable: true }),
  enrichment_lot_id: Object.freeze({ producer: "tender.enrichment_lots", nullable: true, note: "Parser-local tender.enrichment_lots UUID; never exposed as canonical lot_id." }),
  enrichment_version_id: Object.freeze({ producer: "current exact enrichment context binding", nullable: true }),
  publication_source: Object.freeze({ producer: "tender import/source reference", nullable: false }),
  document_portal_id: Object.freeze({ producer: "authoritative DOCUMENT_PORTAL resolution", nullable: true }),
  submission_portal_id: Object.freeze({ producer: "authoritative SUBMISSION_PORTAL resolution", nullable: true }),
  credential_scope_id: Object.freeze({ producer: "exact tenant/company/portal credential binding", nullable: true }),
  credential_status: Object.freeze({ producer: "canonical portal access state machine", nullable: true }),
  region_version_id: Object.freeze({ producer: "active exact region profile binding", nullable: true }),
  relevance_version: Object.freeze({ producer: "current exact company/tender/lot relevance evaluation", nullable: true }),
});

export const TENDER_CONTEXT_STAGES = Object.freeze({
  LIST: Object.freeze(["tenant_id", "company_id", "tender_id", "publication_source"]),
  DETAIL: Object.freeze(["tenant_id", "company_id", "tender_id", "tender_version_id", "publication_source", "relevance_version"]),
  LOT_ACTION: Object.freeze(["tenant_id", "company_id", "tender_id", "tender_version_id", "lot_id", "lot_key"]),
  DOCUMENT_PUBLIC: Object.freeze(["tenant_id", "company_id", "tender_id", "tender_version_id", "lot_id", "lot_key", "enrichment_version_id", "document_portal_id"]),
  DOCUMENT_PROTECTED: Object.freeze(["tenant_id", "company_id", "tender_id", "tender_version_id", "lot_id", "lot_key", "enrichment_version_id", "document_portal_id", "credential_scope_id", "credential_status"]),
  ANALYSIS: Object.freeze(["tenant_id", "company_id", "tender_id", "tender_version_id", "lot_id", "lot_key", "enrichment_version_id"]),
  CALCULATION: Object.freeze(["tenant_id", "company_id", "tender_id", "tender_version_id", "lot_id", "lot_key", "enrichment_version_id", "relevance_version"]),
  PACKAGE: Object.freeze(["tenant_id", "company_id", "tender_id", "tender_version_id", "lot_id", "lot_key", "enrichment_version_id"]),
  SUBMISSION_PREFLIGHT: Object.freeze(["tenant_id", "company_id", "tender_id", "tender_version_id", "lot_id", "lot_key", "enrichment_version_id", "submission_portal_id", "credential_scope_id", "credential_status"]),
});

const aliases = Object.freeze({
  tenant_id: ["tenant_id", "tenantId"],
  company_id: ["company_id", "companyId"],
  tender_id: ["tender_id", "tenderId"],
  tender_version_id: ["tender_version_id", "tenderVersionId"],
  lot_id: ["lot_id", "lotId", "canonical_lot_id", "canonicalLotId"],
  lot_key: ["lot_key", "lotKey", "source_lot_id", "sourceLotId"],
  enrichment_lot_id: ["enrichment_lot_id", "enrichmentLotId"],
  enrichment_version_id: ["enrichment_version_id", "enrichmentVersionId"],
  publication_source: ["publication_source", "publicationSource", "source_code", "sourceCode"],
  document_portal_id: ["document_portal_id", "documentPortalId"],
  submission_portal_id: ["submission_portal_id", "submissionPortalId"],
  credential_scope_id: ["credential_scope_id", "credentialScopeId", "credential_id", "credentialId"],
  credential_status: ["credential_status", "credentialStatus"],
  region_version_id: ["region_version_id", "regionVersionId", "region_profile_version_id", "active_region_version_id"],
  relevance_version: ["relevance_version", "relevanceVersion", "assessment_version_id", "assessmentVersionId"],
});

const asRecord = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const first = (record, names) => {
  for (const name of names) if (Object.prototype.hasOwnProperty.call(record, name)) return record[name];
  return null;
};
const normalizedScalar = (value) => value === null || value === undefined || value === "" ? null : String(value);

const blockerFor = (missing) => {
  if (missing.some((field) => field === "lot_id" || field === "lot_key")) return "LOT_SELECTION_REQUIRED";
  if (missing.includes("enrichment_version_id")) return "ENRICHMENT_INITIALIZATION_REQUIRED";
  if (missing.some((field) => field === "document_portal_id" || field === "submission_portal_id")) return "PORTAL_RESOLUTION_REQUIRED";
  if (missing.some((field) => field === "credential_scope_id" || field === "credential_status")) return "PORTAL_ACCESS_REQUIRED";
  if (missing.includes("region_version_id")) return "REGION_CONFIGURATION_REQUIRED";
  return "DATA_CONTEXT_REPAIR_REQUIRED";
};

/**
 * Normalizes identifiers without deriving or inventing any identity. The
 * result is suitable for UI/read models and for fail-closed action gates.
 */
export function normalizeTenderContext(input, { stage = "DETAIL" } = {}) {
  const source = asRecord(input), context = {};
  for (const field of Object.keys(TENDER_CONTEXT_FIELDS)) {
    const value = first(source, aliases[field]);
    context[field] = normalizedScalar(value);
  }
  context.schema_version = TENDER_CONTEXT_SCHEMA_VERSION;

  const invalid = [];
  for (const field of UUID_FIELDS) if (context[field] !== null && !UUID.test(context[field])) invalid.push(field);
  if (context.credential_status !== null && !PORTAL_STATUSES.has(context.credential_status)) invalid.push("credential_status");
  if ((context.lot_id === null) !== (context.lot_key === null)) invalid.push("lot_identity_pair");
  if (context.credential_scope_id !== null && context.credential_status === null) invalid.push("credential_status");
  if (context.credential_scope_id === null && context.credential_status !== null) invalid.push("credential_scope_id");

  const required = TENDER_CONTEXT_STAGES[stage];
  if (!required) throw new TypeError(`Unknown tender context stage: ${stage}`);
  const missing = required.filter((field) => context[field] === null);
  const protectedCredentialStage = stage === "DOCUMENT_PROTECTED" || stage === "SUBMISSION_PREFLIGHT";
  const credentialNotUsable = protectedCredentialStage && context.credential_status !== null && context.credential_status !== "VALID";
  const status = invalid.length
    ? "DATA_CONTEXT_REPAIR_REQUIRED"
    : missing.length
      ? blockerFor(missing)
      : credentialNotUsable
        ? "PORTAL_ACCESS_REQUIRED"
      : "READY";
  return Object.freeze({
    schemaVersion: TENDER_CONTEXT_SCHEMA_VERSION,
    stage,
    status,
    context: Object.freeze(context),
    missing: Object.freeze(missing),
    invalid: Object.freeze([...new Set(invalid)]),
    actionAllowed: status === "READY",
  });
}

export function tenderContextForStage(input, stage) {
  return normalizeTenderContext(input, { stage });
}
