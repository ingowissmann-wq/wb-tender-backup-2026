const DOCUMENT_REQUIREMENT_KINDS = new Set([
  "REQUIRED_DOCUMENT",
  "PORTAL_FORM",
  "CONCEPT",
  "REFERENCE",
]);

const VIEW_ACTIONS = new Map([
  ["MANAGEMENT_APPROVAL_INVALID", ["management-output", "Managementfreigabe bearbeiten"]],
  ["BID_PACKAGE_NOT_READY", ["offer-documents", "Angebotsunterlagen bearbeiten"]],
  ["PACKAGE_MAPPING_INCOMPLETE", ["offer-documents", "Paketzuordnung bearbeiten"]],
  ["DOCUMENT_FORMAT_INVALID", ["offer-documents", "Dateiformate prüfen"]],
  ["DOCUMENT_SIZE_INVALID", ["offer-documents", "Dateigrößen prüfen"]],
  ["PORTAL_FIELDS_INCOMPLETE", ["offer-documents", "Pflichtfelder bearbeiten"]],
  ["PORTAL_ACCOUNT_REQUIRED", ["portal-access", "Portalzugang bearbeiten"]],
  ["PORTAL_CREDENTIALS_REQUIRED", ["portal-access", "Portalzugang bearbeiten"]],
  ["PORTAL_ACCOUNT_READ_ONLY", ["portal-access", "Portalzugang prüfen"]],
  ["PORTAL_SESSION_REQUIRED", ["portal-access", "Portalsitzung prüfen"]],
  ["MFA_REQUIRED", ["portal-access", "MFA und Portalzugang prüfen"]],
  ["SUBMISSION_TARGET_UNRESOLVED", ["portal-access", "Portalkontext prüfen"]],
  ["REGISTRATION_REQUIRED", ["portal-access", "Portalzugang bearbeiten"]],
  ["ACCOUNT_FOR_OTHER_COMPANY", ["portal-access", "Gesellschaftsgebundenen Zugang prüfen"]],
  ["NOT_AUTHORITATIV_VERIFIED", ["portal-access", "Bieteridentität prüfen"]],
  ["SIGNATURE_REQUIREMENT_UNKNOWN", ["signatures", "Signaturanforderungen prüfen"]],
  ["SIGNATURE_REQUIRED", ["signatures", "Signatur bearbeiten"]],
  ["AMENDMENTS_NOT_CHECKED", ["detail", "Nachträge und Nachrichten prüfen"]],
  ["SUBMISSION_VERSION_CHANGED", ["management-output", "Aktuelle Version prüfen"]],
  ["CURRENT_CONTEXT_BINDING_INVALID", ["management-output", "Aktuellen Freigabestand prüfen"]],
  ["PORTAL_VALIDATION_FAILED", ["submission-status", "Preflight erneut prüfen"]],
  ["AUTOPILOT_SUBMISSION_NOT_IMPLEMENTED", ["portal-access", "Betroffenen Submission-Adapter bearbeiten"]],
  ["PORTAL_SUBMISSION_UNAVAILABLE", ["portal-access", "Portal-Capability prüfen"]],
]);

const finalRequirementKind = (code) =>
  String(code || "").match(/^FINAL_PREFLIGHT_(.+)$/)?.[1] || "";

export function resolveSubmissionBlockerActions(blocker, exactSource = null) {
  const code = String(blocker?.code || ""),
    kind = finalRequirementKind(code),
    requirementId = blocker?.requiredDocumentId || null;
  if (
    requirementId ||
    code === "REQUIRED_DOCUMENT_INCOMPLETE" ||
    code === "REQUIRED_DOCUMENTS_MISSING" ||
    DOCUMENT_REQUIREMENT_KINDS.has(kind)
  ) {
    if (
      requirementId &&
      exactSource?.available === true &&
      String(exactSource.requiredDocumentId) === String(requirementId) &&
      exactSource.documentId
    ) {
      return [
        { type: "source-open", label: "Quelle öffnen", requiredDocumentId: requirementId, documentId: exactSource.documentId, page: exactSource.page || null, mimeType: exactSource.mimeType || null },
        { type: "source-download", label: "Quelldokument herunterladen", requiredDocumentId: requirementId, documentId: exactSource.documentId },
      ];
    }
    return [{ type: "required-document", label: "Erforderliche Unterlage bearbeiten", requiredDocumentId: requirementId }];
  }
  if (kind === "PRICE_FIELD" || kind === "MISSING_INPUT")
    return [{ type: "view", view: "calculation", label: "Kalkulation bearbeiten" }];
  if (kind === "USER_CONFIRMATION" || kind === "MANAGEMENT_REVIEW")
    return [{ type: "view", view: "management-output", label: "Managementprüfung bearbeiten" }];
  if (kind === "SIGNATURE")
    return [{ type: "view", view: "signatures", label: "Signatur bearbeiten" }];
  if (kind === "PORTAL_BLOCKER")
    return [{ type: "view", view: "portal-access", label: "Portalzugang prüfen" }];
  const mapped = VIEW_ACTIONS.get(code);
  return mapped ? [{ type: "view", view: mapped[0], label: mapped[1] }] : [];
}

export function decorateSubmissionBlockers(blockers, exactSources = new Map(), scope = null) {
  return (Array.isArray(blockers) ? blockers : []).map((blocker) => ({
    ...blocker,
    actions: resolveSubmissionBlockerActions(
      blocker,
      blocker?.requiredDocumentId
        ? exactSources.get(String(blocker.requiredDocumentId)) || null
        : null,
    ).map((action) => {
      if (action.view === "management-output" && blocker.code === "MANAGEMENT_APPROVAL_INVALID" && blocker.approvalTruth?.changes?.length)
        return { ...action, label: "Aktuelle Version erneut prüfen und freigeben" };
      return action.view === "portal-access" && scope ? { ...action, portalScope: scope, focus: blocker.code === "AUTOPILOT_SUBMISSION_NOT_IMPLEMENTED" || blocker.code === "PORTAL_SUBMISSION_UNAVAILABLE" ? "adapter" : "permissions" } : action;
    }),
  }));
}
