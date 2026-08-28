import { explicitDocumentLotKeys } from "./generic-final-preflight.mjs";

const successfulStates = new Set([
  "VORHANDEN",
  "DOWNLOAD_SUCCEEDED",
  "VERIFIED",
  "TENDER_AND_LOT_VERIFIED",
  "TENDER_VERIFIED_LOT_GLOBAL",
  "PROCUREMENT_DOCUMENTS_VERIFIED",
]);

const processingStates = new Set([
  "PENDING",
  "CLAIMED",
  "QUEUED",
  "RETRY",
  "RUNNING",
  "AUTOMATIC_PROCESSING_ACTIVE",
  "AUTOMATIC_PROCESSING_PLANNED",
]);

const portalStates = new Set([
  "PORTAL_ACCESS_REQUIRED",
  "PORTALZUGANG_ERFORDERLICH",
  "SESSION_NICHT_FUER_DOWNLOAD_GUELTIG",
  "MFA_REQUIRED",
]);

const failureStates = new Set([
  "DOWNLOAD_FAILED",
  "DOCUMENT_NOT_AVAILABLE",
  "DOCUMENT_NOT_FOUND",
  "ACCESS_DENIED",
  "DOWNLOADLINK_NICHT_AUFGELOEST",
  "PARSER_FAILED",
  "ANALYSIS_FAILED",
]);

const values = (value) =>
  Array.isArray(value) ? value : value == null || value === "" ? [] : [value];

const compoundLotKeys = (value) => {
  const found = new Set();
  for (const match of String(value || "").matchAll(/(?:^|[^a-z0-9])los\s*(\d{1,4})\s*(?:u(?:nd)?|[+&,/])\s*(\d{1,4})(?=$|[^a-z0-9])/gi)) {
    found.add(`LOT-${String(Number(match[1])).padStart(4, "0")}`);
    found.add(`LOT-${String(Number(match[2])).padStart(4, "0")}`);
  }
  return [...found];
};

export function documentLotKeys(document = {}) {
  const provenance = document.provenance || {};
  return [
    ...new Set([
      ...values(document.document_lot_key),
      ...values(provenance.lotKey),
      ...values(provenance.lotKeys),
      ...explicitDocumentLotKeys(
        `${document.filename || ""} ${provenance.archivePath || ""} ${provenance.sourceFolderPath || ""}`,
      ),
      ...compoundLotKeys(
        `${document.filename || ""} ${provenance.archivePath || ""} ${provenance.sourceFolderPath || ""}`,
      ),
    ].map(String).filter(Boolean)),
  ];
}

export function documentInScope(document, lotKey = "") {
  if (document.procurement_relevant === false) return false;
  if (document.document_class === "GENERAL_PORTAL_DOCUMENT") return false;
  if (document.tender_association_verified === false) return false;
  const keys = documentLotKeys(document);
  return !lotKey || keys.length === 0 || keys.includes(lotKey);
}

const hasState = (document, states) =>
  [
    document.procurement_verification_status,
    document.resolution_status,
    document.fetch_status,
    document.parser_status,
  ].some((state) => states.has(String(state || "")));

export function documentFacts(document, lotKey = "") {
  const lotKeys = documentLotKeys(document),
    portalAction = hasState(document, portalStates),
    failed = hasState(document, failureStates),
    loaded = !failed && (Boolean(document.has_content) || hasState(document, successfulStates)),
    analyzed = !failed && (Boolean(document.has_extracted_data) || Boolean(document.parser && !/^(NONE|NOT_|UNPARSED)/i.test(document.parser))),
    processing = hasState(document, processingStates),
    scope = lotKeys.length
      ? lotKey && lotKeys.includes(lotKey)
        ? lotKey
        : lotKeys.join(", ")
      : "TENDER_GLOBAL",
    multiLot = Boolean(lotKey && lotKeys.includes(lotKey) && lotKeys.length > 1);
  return { loaded, analyzed, portalAction, failed, processing, scope, lotKeys, multiLot };
}

export function buildDocumentWorkbench(rows = [], { lotKey = "", page = 1, pageSize = 12 } = {}) {
  const scoped = rows.filter((row) => documentInScope(row, lotKey));
  const deduped = new Map();
  for (const row of scoped) {
    const key = row.payload_sha256 || `${row.filename || ""}|${row.source_url || ""}|${row.document_type || ""}`;
    const prior = deduped.get(key);
    if (!prior || (documentLotKeys(prior).length === 0 && documentLotKeys(row).length > 0)) deduped.set(key, row);
  }
  const documents = [...deduped.values()].map((row) => ({ ...row, ...documentFacts(row, lotKey) }));
  const total = documents.length,
    safeSize = Math.min(50, Math.max(5, Number(pageSize) || 12)),
    pages = Math.max(1, Math.ceil(total / safeSize)),
    safePage = Math.min(pages, Math.max(1, Number(page) || 1)),
    loaded = documents.filter((row) => row.loaded).length,
    analyzed = documents.filter((row) => row.analyzed).length,
    openOrFailed = documents.filter((row) => row.failed || row.portalAction || !row.loaded || !row.analyzed).length,
    processing = documents.filter((row) => row.processing).length,
    failed = documents.filter((row) => row.failed).length,
    portalAction = documents.filter((row) => row.portalAction).length,
    notLoaded = documents.filter((row) => !row.loaded).length,
    notAnalyzed = documents.filter((row) => row.loaded && !row.analyzed).length;
  return {
    summary: {
      total,
      loaded,
      analyzed,
      openOrFailed,
      processing,
      failed,
      portalAction,
      notLoaded,
      notAnalyzed,
      status: processing
        ? "PROCESSING"
        : openOrFailed
          ? "ACTION_REQUIRED"
          : total
            ? "COMPLETE"
            : "NO_DOCUMENTS",
    },
    items: documents.slice((safePage - 1) * safeSize, safePage * safeSize),
    pagination: { page: safePage, pageSize: safeSize, pages, total },
  };
}
