const unique = (values) => [...new Set((values || []).flat().filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];

export const NOTICE_CLASSIFICATIONS = Object.freeze([
  "COMPETITION", "CORRIGENDUM", "PRIOR_INFORMATION", "RESULT",
  "CONTRACT_MODIFICATION", "CANCELLATION", "VOLUNTARY_EX_ANTE", "UNKNOWN",
]);

const TED_NOTICE_TYPES = Object.freeze({
  "can-standard": "RESULT", "can-social": "RESULT", "can-desg": "RESULT", "can-tran": "RESULT",
  "can-modif": "CONTRACT_MODIFICATION",
  "cn-standard": "COMPETITION", "cn-social": "COMPETITION", "cn-desg": "COMPETITION",
  "cn-tran": "COMPETITION", "qu-sy": "COMPETITION", subco: "COMPETITION",
  "pin-only": "PRIOR_INFORMATION", "pin-buyer": "PRIOR_INFORMATION",
  "pin-cfc-standard": "PRIOR_INFORMATION", "pin-cfc-social": "PRIOR_INFORMATION",
  "pin-rtl": "PRIOR_INFORMATION", "pin-tran": "PRIOR_INFORMATION", pmc: "PRIOR_INFORMATION",
  veat: "VOLUNTARY_EX_ANTE",
});

const terminal = new Set(["RESULT", "CONTRACT_MODIFICATION", "CANCELLATION", "VOLUNTARY_EX_ANTE"]);
const eligibleTypes = new Set(["COMPETITION", "CORRIGENDUM"]);

const normalizedTags = (value) => unique(value).map((item) => item.toLowerCase());

export function classifyNotice({ sourceCode, noticeType, formType, noticeSubtype, tags, sourceStatus } = {}) {
  const source = String(sourceCode || "").toUpperCase();
  const type = String(noticeType || "").trim().toLowerCase();
  const form = String(formType || "").trim().toLowerCase();
  const status = String(sourceStatus || "").trim().toLowerCase();
  const allTags = normalizedTags(tags);
  const evidence = { source, noticeType: type || null, formType: form || null, noticeSubtype: noticeSubtype || null, tags: allTags };

  if (/(cancel|withdraw|terminated|unsuccessful|aufgehoben|zurückgezogen)/.test(`${type} ${form} ${status} ${allTags.join(" ")}`))
    return { classification: "CANCELLATION", evidence };
  if (source === "TED" && TED_NOTICE_TYPES[type]) return { classification: TED_NOTICE_TYPES[type], evidence };
  if (source === "DOE") {
    if (allTags.some((tag) => tag === "tendercancellation" || tag === "contracttermination")) return { classification: "CANCELLATION", evidence };
    if (allTags.some((tag) => tag === "award" || tag === "contract")) return { classification: "RESULT", evidence };
    if (allTags.some((tag) => tag === "tenderamendment")) return { classification: "CORRIGENDUM", evidence };
    if (allTags.some((tag) => tag === "tender")) return { classification: "COMPETITION", evidence };
    if (allTags.some((tag) => tag === "planning")) return { classification: "PRIOR_INFORMATION", evidence };
  }
  return { classification: "UNKNOWN", evidence };
}

export function resolveNoticeLifecycle({ classification, offerDeadline, sourceStatus, newerTerminalNotice = null, now = new Date() } = {}) {
  const deadline = offerDeadline && !Number.isNaN(Date.parse(offerDeadline)) ? new Date(offerDeadline) : null;
  const sourceEnded = /(closed|complete|award|cancel|withdraw|terminated|unsuccessful|beendet|vergeben|aufgehoben|zurückgezogen)/i.test(String(sourceStatus || ""));
  let sourceLifecycleStatus = "REVIEW_REQUIRED", participationStatus = "REVIEW_REQUIRED", blockReason = "NOTICE_CLASSIFICATION_INCOMPLETE";

  if (classification === "CANCELLATION") {
    sourceLifecycleStatus = "WITHDRAWN"; participationStatus = "NOT_ELIGIBLE"; blockReason = "NOTICE_CANCELLED";
  } else if (terminal.has(classification)) {
    sourceLifecycleStatus = "CLOSED"; participationStatus = "NOT_ELIGIBLE"; blockReason = `NOTICE_${classification}`;
  } else if (newerTerminalNotice) {
    sourceLifecycleStatus = "CLOSED"; participationStatus = "NOT_ELIGIBLE"; blockReason = "NEWER_RELATED_NOTICE_CLOSED_PROCEDURE";
  } else if (!eligibleTypes.has(classification)) {
    blockReason = classification === "PRIOR_INFORMATION" ? "PRIOR_INFORMATION_NOT_COMPETITION" : "NOTICE_CLASSIFICATION_INCOMPLETE";
  } else if (sourceEnded) {
    sourceLifecycleStatus = "CLOSED"; participationStatus = "NOT_ELIGIBLE"; blockReason = "SOURCE_MARKED_PROCEDURE_ENDED";
  } else if (!deadline) {
    blockReason = "FUTURE_TENDER_DEADLINE_REQUIRED";
  } else if (deadline <= now) {
    sourceLifecycleStatus = "EXPIRED"; participationStatus = "NOT_ELIGIBLE"; blockReason = "TENDER_DEADLINE_EXPIRED";
  } else {
    sourceLifecycleStatus = "ACTIVE"; participationStatus = "ELIGIBLE"; blockReason = null;
  }
  return { sourceLifecycleStatus, participationStatus, blockReason };
}

export function classifyAndResolveNotice(input = {}) {
  const classified = classifyNotice(input);
  return { ...classified, ...resolveNoticeLifecycle({ ...input, classification: classified.classification }) };
}

export function noticeRelationships({ sourceCode, externalId, procedureIdentifier, previousNoticeIds } = {}) {
  return unique(previousNoticeIds).filter((id) => id !== externalId).map((relatedExternalId) => ({
    sourceCode: String(sourceCode || "").toUpperCase(),
    sourceExternalId: externalId,
    relatedExternalId,
    procedureIdentifier: procedureIdentifier || null,
    relationshipType: "PREVIOUS_NOTICE",
  }));
}

export function assertParticipationEligible(row, lot = null, now = new Date()) {
  if (row?.source_lifecycle_status !== "ACTIVE" || !["ELIGIBLE","PARTIALLY_ELIGIBLE"].includes(row?.participation_status)
    || !lot?.lot_key || lot.lifecycle_status !== "ACTIVE" || lot.participation_status !== "ELIGIBLE"
    || !lot.offer_deadline || new Date(lot.offer_deadline) <= now) {
    const error = new Error("Diese Bekanntmachung ist nicht für die Teilnahme freigegeben.");
    error.code = lot?.participation_block_reason || row?.participation_block_reason || "TENDER_LOT_NOT_PARTICIPATION_ELIGIBLE";
    error.httpStatus = 409;
    throw error;
  }
  return row;
}
