const RUNNING_JOB_STATES = new Set(["QUEUED", "PENDING", "CLAIMED", "RETRY", "RUNNING"]);
const CAPTCHA_CODES = new Set(["CAPTCHA_REQUIRED", "CAPTCHA_MANUELL_ERFORDERLICH"]);
const MFA_CODES = new Set(["MFA_REQUIRED", "MFA_BESTÄTIGUNG_ERFORDERLICH"]);
const LOCKED_CODES = new Set(["KONTO_GESPERRT", "ACCOUNT_LOCKED", "LOCKED"]);
const INVALID_CODES = new Set([
  "BENUTZERNAME_ODER_PASSWORT_FALSCH",
  "INVALID_CREDENTIALS",
  "LOGIN_FAILED",
]);
const EXPIRED_CODES = new Set(["PASSWORT_ABGELAUFEN", "CREDENTIAL_EXPIRED"]);
const UNAVAILABLE_CODES = new Set([
  "PORTAL_UNREACHABLE",
  "NETWORK_ERROR",
  "TIMEOUT",
  "EXTERNAL_PORTAL_UNAVAILABLE",
  "PORTAL_NICHT_ERREICHBAR",
]);
const EXPIRED_SESSION_STATES = new Set([
  "EXPIRED",
  "REVOKED",
  "RELOGIN_REQUIRED_EXPIRED",
  "RELOGIN_REQUIRED_REVOKED",
]);

export const PORTAL_ACCESS_STATUSES = Object.freeze([
  "NOT_CONFIGURED",
  "CONFIGURED_UNVERIFIED",
  "VALID",
  "MFA_REQUIRED",
  "CAPTCHA_OR_USER_ACTION_REQUIRED",
  "EXPIRED",
  "INVALID",
  "LOCKED",
  "PORTAL_UNAVAILABLE",
  "VALIDATION_PENDING",
]);

/**
 * Canonical credential truth. Document availability is deliberately absent:
 * downloaded files neither prove nor invalidate a current portal login.
 */
export function canonicalPortalAccessStatus({
  configured = false,
  credentialStatus = null,
  credentialRevokedAt = null,
  credentialValidUntil = null,
  loginStatus = null,
  sessionEffectiveStatus = null,
  jobStatus = null,
  jobResultCode = null,
  mfaRequired = false,
  captchaRequired = false,
  accountLocked = false,
  now = new Date(),
} = {}) {
  if (!configured) return "NOT_CONFIGURED";
  const resultCode = String(jobResultCode || "").toUpperCase();
  if (accountLocked || LOCKED_CODES.has(resultCode) || loginStatus === "ZUGANG_GESPERRT")
    return "LOCKED";
  if (CAPTCHA_CODES.has(resultCode)) return "CAPTCHA_OR_USER_ACTION_REQUIRED";
  if (MFA_CODES.has(resultCode) || loginStatus === "MFA_ERFORDERLICH") return "MFA_REQUIRED";
  if (RUNNING_JOB_STATES.has(jobStatus)) return "VALIDATION_PENDING";
  if (INVALID_CODES.has(resultCode)) return "INVALID";
  const validity = credentialValidUntil ? new Date(credentialValidUntil) : null;
  if (
    credentialRevokedAt ||
    ["REVOKED", "EXPIRED", "REPLACED"].includes(credentialStatus) ||
    loginStatus === "ZUGANG_ABGELAUFEN" ||
    EXPIRED_CODES.has(resultCode) ||
    (validity && !Number.isNaN(validity.valueOf()) && validity <= now) ||
    EXPIRED_SESSION_STATES.has(sessionEffectiveStatus)
  ) return "EXPIRED";
  if (UNAVAILABLE_CODES.has(resultCode)) return "PORTAL_UNAVAILABLE";
  if (sessionEffectiveStatus === "ACTIVE" || loginStatus === "LOGIN_BESTAETIGT" || resultCode === "LOGIN_ERFOLGREICH")
    return "VALID";
  if (captchaRequired) return "CAPTCHA_OR_USER_ACTION_REQUIRED";
  if (mfaRequired) return "MFA_REQUIRED";
  return "CONFIGURED_UNVERIFIED";
}

const PRESENTATION = Object.freeze({
  NOT_CONFIGURED: {
    label: "Kein Portalzugang hinterlegt",
    message: "Für dieses Portal ist ein Zugang einzurichten.",
    actionType: "MANAGE_CREDENTIALS",
    actionLabel: "Zugangsdaten hinterlegen",
  },
  CONFIGURED_UNVERIFIED: {
    label: "Zugang gespeichert, noch nicht verifiziert",
    message: "Zugangsdaten gespeichert, Anmeldung noch nicht verifiziert.",
    actionType: "START_LOGIN",
    actionLabel: "Zugang prüfen",
  },
  VALID: {
    label: "Gültiger Portalzugang vorhanden",
    message: "Gültiger Portalzugang vorhanden.",
    actionType: "OPEN_PORTAL_READ_ONLY",
    actionLabel: "Portal öffnen",
  },
  MFA_REQUIRED: {
    label: "MFA-Bestätigung erforderlich",
    message: "Zugang vorhanden – MFA-Bestätigung erforderlich.",
    actionType: "CONFIRM_MFA",
    actionLabel: "MFA fortsetzen",
  },
  CAPTCHA_OR_USER_ACTION_REQUIRED: {
    label: "Fortsetzung im Portal erforderlich",
    message: "Zugang vorhanden – Fortsetzung im Portal erforderlich.",
    actionType: "CONFIRM_CAPTCHA",
    actionLabel: "CAPTCHA fortsetzen",
  },
  EXPIRED: {
    label: "Portalzugang oder Sitzung abgelaufen",
    message: "Zugang vorhanden, Sitzung oder Zugang abgelaufen.",
    actionType: "MANAGE_CREDENTIALS",
    actionLabel: "Zugang aktualisieren",
  },
  INVALID: {
    label: "Portalzugang ungültig",
    message: "Gespeicherte Zugangsdaten wurden vom Portal abgewiesen.",
    actionType: "MANAGE_CREDENTIALS",
    actionLabel: "Zugang aktualisieren",
  },
  LOCKED: {
    label: "Portalzugang gesperrt",
    message: "Portalzugang gesperrt – Betreiberprüfung erforderlich.",
    actionType: "NONE",
    actionLabel: null,
  },
  PORTAL_UNAVAILABLE: {
    label: "Portal vorübergehend nicht erreichbar",
    message: "Der gespeicherte Zugang ist vorhanden; das Portal ist derzeit nicht erreichbar.",
    actionType: "NONE",
    actionLabel: null,
  },
  VALIDATION_PENDING: {
    label: "Zugangsprüfung läuft",
    message: "Zugangsdaten sind gespeichert; die Anmeldung wird derzeit geprüft.",
    actionType: "NONE",
    actionLabel: null,
  },
});

export function portalAccessPresentation(status) {
  return PRESENTATION[status] || PRESENTATION.CONFIGURED_UNVERIFIED;
}
