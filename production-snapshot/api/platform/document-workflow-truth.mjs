const ACTIVE = new Set(["PENDING", "QUEUED", "RETRY", "CLAIMED", "RUNNING"]);
const COMPLETE = new Set(["COMPLETED", "SUCCEEDED", "DONE"]);

const amount = (value) => Math.max(0, Number(value) || 0);

/**
 * Authoritative document-workflow projection used by API, UI and retry gates.
 * A stale portal/session diagnostic can never override proven completeness.
 */
export function deriveDocumentWorkflowTruth(input = {}) {
  const required = amount(input.documentsRequired ?? input.documentsFound),
    found = amount(input.documentsFound),
    downloaded = amount(input.documentsDownloaded),
    analyzed = amount(input.documentsAnalyzed),
    processingStatus = String(input.processingStatus || ""),
    processingStep = String(input.processingStep || ""),
    completed = COMPLETE.has(processingStatus) || processingStep === "COMPLETED",
    discoveryComplete = required > 0 && found >= required,
    downloadComplete = discoveryComplete && downloaded >= required,
    analysisComplete = downloadComplete && analyzed >= required,
    complete = analysisComplete && completed,
    missingRequired = Math.max(0, required - Math.min(found, downloaded, analyzed));

  if (complete)
    return Object.freeze({
      required, found, downloaded, analyzed,
      complete: true,
      missingRequired: 0,
      accessStatus: "DOCUMENTS_AVAILABLE",
      resolutionStatus: "DOWNLOAD_SUCCEEDED",
      processingStatus: "COMPLETED",
      blocker: null,
      error: null,
      nextRetry: null,
      retryRequired: false,
      automaticProcessing: false,
    });

  const active = ACTIVE.has(processingStatus);
  return Object.freeze({
    required, found, downloaded, analyzed,
    complete: false,
    missingRequired,
    accessStatus: downloaded > 0
      ? (downloaded < required ? "DOCUMENTS_PARTIALLY_AVAILABLE" : input.accessStatus)
      : input.accessStatus,
    resolutionStatus: input.resolutionStatus || null,
    processingStatus: processingStatus || null,
    blocker: input.blocker || null,
    error: input.error || null,
    nextRetry: active ? input.nextRetry || null : null,
    retryRequired: missingRequired > 0 && Boolean(input.resolutionStatus || input.blocker || input.error),
    automaticProcessing: active && missingRequired > 0,
  });
}

export function requiresDocumentLinkResolution(input = {}) {
  const truth = deriveDocumentWorkflowTruth(input);
  return !truth.complete && truth.missingRequired > 0;
}
