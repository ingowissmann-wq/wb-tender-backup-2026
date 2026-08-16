const credentialFailureCodes = new Set([
  "BENUTZERNAME_ODER_PASSWORT_FALSCH",
  "PASSWORT_ABGELAUFEN",
  "KONTO_GESPERRT",
]);

const retryableLoginFailureCodes = new Set([
  "LOGIN_FORMULAR_GEAENDERT",
  "LOGIN_REDIRECT_UNERWARTET",
  "SESSION_COOKIE_FEHLT",
  "SESSION_CREATION_FAILED",
]);

const nonAuthenticationBlockers = new Set([
  "PORTAL_UNREACHABLE",
  "ACCESS_DENIED",
  "DOCUMENT_NOT_FOUND",
  "EXTERNAL_DOCUMENT_REQUEST_REQUIRED",
]);

const bindingFor = ({ tenderId, companyId, portalId, lotKey = "" }) =>
  Object.freeze({
    tender_id: String(tenderId || ""),
    company_id: String(companyId || ""),
    portal_id: String(portalId || ""),
    lot_key: String(lotKey || ""),
  });

/**
 * Canonical decision point for the portal primary action. Authentication,
 * read-only opening and credential management are distinct from refresh.
 */
export function portalLoginAction(
  {
    tenderId,
    companyId,
    portalId,
    lotKey = "",
    accessStatus,
    configured = false,
    sessionStatus = null,
    sessionEffectiveStatus = null,
    lastError = null,
    lastSuccessfulLogin = null,
    publicDocumentAccess = false,
    documentsComplete = false,
    portalOpenAvailable = false,
    authenticationTargetConfigured = false,
  } = {},
  now = new Date(),
) {
  const binding = bindingFor({ tenderId, companyId, portalId, lotKey });
  const result = (type, label, reason) => ({ type, label, reason, binding });
  // This decision point consumes the database-canonical effective truth; it
  // must not reinterpret stored status, expiry, revocation, or verification.
  const sessionValid = sessionEffectiveStatus === "ACTIVE";
  const sessionExpired = [
    "RELOGIN_REQUIRED_EXPIRED",
    "RELOGIN_REQUIRED_REVOKED",
  ].includes(sessionEffectiveStatus);

  // Public document profiles do not acquire an authentication requirement
  // merely because an unrelated or historical session is missing/expired.
  // Opening the read-only tender page and refreshing documents are separate
  // UI actions; this primary action never represents a document fetch.
  if (publicDocumentAccess)
    return portalOpenAvailable
      ? result(
          "OPEN_PORTAL_READ_ONLY",
          "Portal öffnen",
          documentsComplete
            ? "PUBLIC_DOCUMENTS_COMPLETE"
            : "PUBLIC_DOCUMENT_ACCESS",
        )
      : result("NONE", null, "PORTAL_OPEN_TARGET_UNAVAILABLE");

  if (!configured || accessStatus === "CREDENTIALS_NOT_CONFIGURED")
    return result(
      "MANAGE_CREDENTIALS",
      "Zugangsdaten hinterlegen",
      "CREDENTIALS_MISSING",
    );

  // A current, verified session wins over stale portal-level diagnostics.
  if (sessionValid)
    return portalOpenAvailable
      ? result("OPEN_PORTAL_READ_ONLY", "Portal öffnen", "SESSION_VALID")
      : result("NONE", null, "SESSION_VALID");

  if (!authenticationTargetConfigured)
    return result(
      "AUTHENTICATION_TARGET_UNAVAILABLE",
      null,
      "PORTAL_AUTHENTICATION_TARGET_NOT_CONFIGURED",
    );

  if (
    accessStatus === "MFA_REQUIRED" ||
    lastError === "MFA_BESTÄTIGUNG_ERFORDERLICH" ||
    lastError === "MFA_REQUIRED"
  )
    return result("CONFIRM_MFA", "MFA bestätigen", "MFA_REQUIRED");

  if (credentialFailureCodes.has(lastError))
    return result(
      "MANAGE_CREDENTIALS",
      "Zugangsdaten hinterlegen",
      lastError,
    );

  if (nonAuthenticationBlockers.has(accessStatus))
    return result("NONE", null, accessStatus);

  if (accessStatus === "SESSION_EXPIRED" || sessionExpired)
    return sessionStatus === null
      ? result("START_LOGIN", "Am Portal anmelden", "SESSION_MISSING")
      : result("START_LOGIN", "Erneut anmelden", "SESSION_EXPIRED");

  if (sessionEffectiveStatus !== null && !sessionValid)
    return result("START_LOGIN", "Erneut anmelden", "SESSION_FAILED");

  if (
    accessStatus === "LOGIN_FAILED" ||
    retryableLoginFailureCodes.has(lastError)
  )
    return result("START_LOGIN", "Erneut anmelden", "LOGIN_FAILED");

  if (
    accessStatus === "LOGIN_REQUIRED" ||
    accessStatus === "SESSION_MISSING" ||
    accessStatus === "DOCUMENTS_AVAILABLE" ||
    accessStatus === "DOWNLOAD_LINK_UNRESOLVED" ||
    accessStatus === null ||
    accessStatus === undefined
  )
    return result(
      "START_LOGIN",
      lastSuccessfulLogin ? "Erneut anmelden" : "Am Portal anmelden",
      lastSuccessfulLogin ? "SESSION_MISSING_AFTER_LOGIN" : "SESSION_MISSING",
    );

  return result("NONE", null, accessStatus || "NOT_REQUIRED");
}
