import { portalAccessPresentation } from "./canonical-portal-access.mjs";

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
    credentialStatus = null,
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
  if (credentialStatus === null) {
    const sessionValid = sessionEffectiveStatus === "ACTIVE";
    const sessionExpired = ["RELOGIN_REQUIRED_EXPIRED", "RELOGIN_REQUIRED_REVOKED"].includes(sessionEffectiveStatus);
    if (["CAPTCHA_REQUIRED", "CAPTCHA_MANUELL_ERFORDERLICH"].includes(accessStatus) || ["CAPTCHA_REQUIRED", "CAPTCHA_MANUELL_ERFORDERLICH"].includes(lastError))
      return result("CONFIRM_CAPTCHA", "CAPTCHA fortsetzen", "CAPTCHA_REQUIRED");
    if (!configured || accessStatus === "CREDENTIALS_NOT_CONFIGURED")
      return result("MANAGE_CREDENTIALS", "Zugangsdaten hinterlegen", "CREDENTIALS_MISSING");
    if (sessionValid)
      return portalOpenAvailable
        ? result("OPEN_PORTAL_READ_ONLY", "Portalansicht öffnen", "SESSION_VALID")
        : result("NONE", null, "SESSION_VALID");
    if (!authenticationTargetConfigured)
      return result("AUTHENTICATION_TARGET_UNAVAILABLE", null, "PORTAL_AUTHENTICATION_TARGET_NOT_CONFIGURED");
    if (accessStatus === "MFA_REQUIRED" || ["MFA_REQUIRED", "MFA_BESTÄTIGUNG_ERFORDERLICH"].includes(lastError))
      return result("CONFIRM_MFA", "MFA bestätigen", "MFA_REQUIRED");
    if (["BENUTZERNAME_ODER_PASSWORT_FALSCH", "INVALID_CREDENTIALS", "PASSWORT_ABGELAUFEN", "KONTO_GESPERRT"].includes(lastError))
      return result("MANAGE_CREDENTIALS", "Zugangsdaten hinterlegen", lastError);
    if (["SESSION_EXPIRED", "SESSION_MISSING", "LOGIN_REQUIRED"].includes(accessStatus) || sessionExpired)
      return result("START_LOGIN", "Erneut anmelden", sessionStatus === null ? "SESSION_MISSING" : "SESSION_EXPIRED");
    if (accessStatus === "PORTAL_UNREACHABLE" || lastError === "PORTAL_NICHT_ERREICHBAR")
      return result("START_LOGIN", "Erneut anmelden", "PORTAL_TEMPORARILY_UNAVAILABLE");
    if (sessionEffectiveStatus !== null)
      return result("START_LOGIN", "Erneut anmelden", "SESSION_FAILED");
    if (publicDocumentAccess)
      return portalOpenAvailable
        ? result("OPEN_PORTAL_READ_ONLY", "Portalansicht öffnen", documentsComplete ? "PUBLIC_DOCUMENTS_COMPLETE" : "PUBLIC_DOCUMENT_ACCESS")
        : result("START_LOGIN", "Erneut anmelden", "SESSION_MISSING");
    if (nonAuthenticationBlockers.has(accessStatus)) return result("NONE", null, accessStatus);
    if (accessStatus === "LOGIN_FAILED" || retryableLoginFailureCodes.has(lastError))
      return result("START_LOGIN", "Erneut anmelden", "LOGIN_FAILED");
    return result("START_LOGIN", lastSuccessfulLogin ? "Erneut anmelden" : "Am Portal anmelden", lastSuccessfulLogin ? "SESSION_MISSING_AFTER_LOGIN" : "SESSION_MISSING");
  }
  const status = credentialStatus,
    presentation = portalAccessPresentation(status);

  if (["NOT_CONFIGURED", "EXPIRED", "INVALID"].includes(status))
    return result(presentation.actionType, presentation.actionLabel, status);
  if (["CREDENTIAL_SCOPE_CONFLICT", "LOCKED", "PORTAL_UNAVAILABLE", "VALIDATION_PENDING"].includes(status))
    return result("NONE", null, status);
  if (status === "VALID")
    return portalOpenAvailable
      ? result("OPEN_PORTAL_READ_ONLY", "Portal öffnen", "CREDENTIAL_VALID")
      : result("NONE", null, "CREDENTIAL_VALID");
  if (!authenticationTargetConfigured)
    return result("AUTHENTICATION_TARGET_UNAVAILABLE", null, "PORTAL_AUTHENTICATION_TARGET_NOT_CONFIGURED");
  if (status === "CAPTCHA_OR_USER_ACTION_REQUIRED")
    return result("CONFIRM_CAPTCHA", presentation.actionLabel, "CAPTCHA_REQUIRED");
  if (status === "MFA_REQUIRED")
    return result("CONFIRM_MFA", presentation.actionLabel, "MFA_REQUIRED");
  if (status === "CONFIGURED_UNVERIFIED")
    return result("START_LOGIN", presentation.actionLabel, status);
  return result("NONE", null, status);
}
