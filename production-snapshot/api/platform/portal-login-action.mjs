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
  // Compatibility is kept for older callers while every rendered API path
  // now supplies the canonical credentialStatus explicitly.
  const legacyStatus = () => {
    if (!configured || accessStatus === "CREDENTIALS_NOT_CONFIGURED") return "NOT_CONFIGURED";
    if (["CAPTCHA_REQUIRED", "CAPTCHA_MANUELL_ERFORDERLICH"].includes(accessStatus) || ["CAPTCHA_REQUIRED", "CAPTCHA_MANUELL_ERFORDERLICH"].includes(lastError)) return "CAPTCHA_OR_USER_ACTION_REQUIRED";
    if (accessStatus === "MFA_REQUIRED" || ["MFA_REQUIRED", "MFA_BESTÄTIGUNG_ERFORDERLICH"].includes(lastError)) return "MFA_REQUIRED";
    if (lastError === "KONTO_GESPERRT") return "LOCKED";
    if (["BENUTZERNAME_ODER_PASSWORT_FALSCH", "INVALID_CREDENTIALS"].includes(lastError)) return "INVALID";
    if (accessStatus === "PORTAL_UNREACHABLE") return "PORTAL_UNAVAILABLE";
    if (sessionEffectiveStatus === "ACTIVE") return "VALID";
    if (accessStatus === "SESSION_EXPIRED" || ["RELOGIN_REQUIRED_EXPIRED", "RELOGIN_REQUIRED_REVOKED"].includes(sessionEffectiveStatus)) return "EXPIRED";
    return "CONFIGURED_UNVERIFIED";
  };
  const status = credentialStatus || legacyStatus(),
    presentation = portalAccessPresentation(status);

  if (["NOT_CONFIGURED", "EXPIRED", "INVALID"].includes(status))
    return result(presentation.actionType, presentation.actionLabel, status);
  if (["LOCKED", "PORTAL_UNAVAILABLE", "VALIDATION_PENDING"].includes(status))
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
