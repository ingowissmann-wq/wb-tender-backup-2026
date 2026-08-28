import crypto from "node:crypto";

export const LIVE_SUBMISSION_STATES = Object.freeze([
  "NOT_READY", "READY_FOR_APPROVAL", "APPROVAL_PENDING", "APPROVED", "QUEUED",
  "AUTHENTICATING", "MFA_REQUIRED", "UPLOADING", "SUBMITTING", "SUBMITTED",
  "RECEIPT_CONFIRMED", "SUBMISSION_UNCERTAIN", "REJECTED_BY_PORTAL",
  "FAILED_RETRYABLE", "FAILED_FINAL", "WITHDRAWAL_PENDING", "WITHDRAWN",
]);

const TERMINAL = new Set(["RECEIPT_CONFIRMED", "REJECTED_BY_PORTAL", "FAILED_FINAL", "WITHDRAWN"]);
const TRANSITIONS = Object.freeze({
  NOT_READY: ["READY_FOR_APPROVAL", "FAILED_FINAL"],
  READY_FOR_APPROVAL: ["APPROVAL_PENDING", "NOT_READY", "FAILED_FINAL"],
  APPROVAL_PENDING: ["APPROVED", "NOT_READY", "FAILED_FINAL"],
  APPROVED: ["QUEUED", "NOT_READY", "FAILED_FINAL"],
  QUEUED: ["AUTHENTICATING", "FAILED_RETRYABLE", "FAILED_FINAL"],
  AUTHENTICATING: ["MFA_REQUIRED", "UPLOADING", "FAILED_RETRYABLE", "FAILED_FINAL"],
  MFA_REQUIRED: ["AUTHENTICATING", "UPLOADING", "SUBMITTING", "SUBMITTED", "SUBMISSION_UNCERTAIN", "WITHDRAWAL_PENDING", "FAILED_FINAL"],
  UPLOADING: ["MFA_REQUIRED", "SUBMITTING", "REJECTED_BY_PORTAL", "FAILED_RETRYABLE", "FAILED_FINAL"],
  SUBMITTING: ["MFA_REQUIRED", "SUBMITTED", "RECEIPT_CONFIRMED", "SUBMISSION_UNCERTAIN", "REJECTED_BY_PORTAL", "FAILED_RETRYABLE", "FAILED_FINAL"],
  SUBMITTED: ["MFA_REQUIRED", "RECEIPT_CONFIRMED", "SUBMISSION_UNCERTAIN", "REJECTED_BY_PORTAL", "WITHDRAWAL_PENDING"],
  RECEIPT_CONFIRMED: ["WITHDRAWAL_PENDING"],
  SUBMISSION_UNCERTAIN: ["MFA_REQUIRED", "SUBMITTED", "RECEIPT_CONFIRMED", "REJECTED_BY_PORTAL", "FAILED_FINAL"],
  REJECTED_BY_PORTAL: [],
  FAILED_RETRYABLE: ["QUEUED", "AUTHENTICATING", "UPLOADING", "FAILED_FINAL"],
  FAILED_FINAL: [],
  WITHDRAWAL_PENDING: ["MFA_REQUIRED", "WITHDRAWN", "SUBMISSION_UNCERTAIN", "FAILED_FINAL"],
  WITHDRAWN: [],
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const stable = value => Array.isArray(value)
  ? value.map(stable)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
    : value;
export const canonicalJson = value => JSON.stringify(stable(value));
export const liveSubmissionHash = value => crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");

const string = (value, name, max = 300) => {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > max) throw Object.assign(new Error(`${name}_invalid`), { code: `${name.toUpperCase()}_INVALID` });
  return normalized;
};
const uuid = (value, name) => {
  const normalized = string(value, name, 36);
  if (!UUID.test(normalized)) throw Object.assign(new Error(`${name}_invalid`), { code: `${name.toUpperCase()}_INVALID` });
  return normalized.toLowerCase();
};
const positiveVersion = (value, name) => {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw Object.assign(new Error(`${name}_invalid`), { code: `${name.toUpperCase()}_INVALID` });
  return normalized;
};

export function immutableSubmissionBinding(input = {}) {
  const binding = {
    schemaVersion: 2,
    tenantId: uuid(input.tenantId, "tenant_id"),
    companyId: uuid(input.companyId, "company_id"),
    tenderId: uuid(input.tenderId, "tender_id"),
    lotId: uuid(input.lotId, "lot_id"),
    portalId: uuid(input.portalId, "portal_id"),
    portalAdapterId: string(input.portalAdapterId, "portal_adapter_id", 120),
    portalAdapterVersion: string(input.portalAdapterVersion, "portal_adapter_version", 80),
    portalHost: string(input.portalHost, "portal_host", 253).toLowerCase(),
    portalTenderUrl: string(input.portalTenderUrl, "portal_tender_url", 2000),
    portalTenderReference: string(input.portalTenderReference, "portal_tender_reference", 300),
    lotKey: string(input.lotKey, "lot_key", 200),
    credentialId: uuid(input.credentialId, "credential_id"),
    credentialVersion: positiveVersion(input.credentialVersion, "credential_version"),
    bidPackageId: uuid(input.bidPackageId, "bid_package_id"),
    bidPackageVersion: positiveVersion(input.bidPackageVersion, "bid_package_version"),
    packageSha256: string(input.packageSha256, "package_sha256", 64).toLowerCase(),
    approvalId: uuid(input.approvalId, "approval_id"),
    deadlineVersion: string(input.deadlineVersion, "deadline_version", 200),
    deadlineEvidenceSha256: string(input.deadlineEvidenceSha256, "deadline_evidence_sha256", 64).toLowerCase(),
    deadlineAt: new Date(input.deadlineAt).toISOString(),
    sourceTimezone: string(input.sourceTimezone, "source_timezone", 80),
    approvalCutoffAt: new Date(input.approvalCutoffAt).toISOString(),
    productCode: string(input.productCode, "product_code", 40),
  };
  if (!SHA256.test(binding.packageSha256)) throw Object.assign(new Error("package_sha256_invalid"), { code: "PACKAGE_SHA256_INVALID" });
  if (!SHA256.test(binding.deadlineEvidenceSha256)) throw Object.assign(new Error("deadline_evidence_sha256_invalid"), { code: "DEADLINE_EVIDENCE_SHA256_INVALID" });
  const portalTenderUrl=new URL(binding.portalTenderUrl);
  if(portalTenderUrl.protocol!=="https:"||portalTenderUrl.username||portalTenderUrl.password||[...portalTenderUrl.searchParams.keys()].some(key=>/(?:token|secret|password|session|cookie|authorization|totp|recovery)/i.test(key)))throw Object.assign(new Error("portal_tender_url_invalid"),{code:"PORTAL_TENDER_URL_INVALID"});
  if (!Number.isFinite(Date.parse(binding.deadlineAt))) throw Object.assign(new Error("deadline_invalid"), { code: "DEADLINE_INVALID" });
  if (!Number.isFinite(Date.parse(binding.approvalCutoffAt))) throw Object.assign(new Error("approval_cutoff_invalid"), { code: "APPROVAL_CUTOFF_INVALID" });
  return Object.freeze(binding);
}

export const submissionIdempotencyKey = input => liveSubmissionHash(immutableSubmissionBinding(input));

export function assertLiveTransition(from, to) {
  if (!LIVE_SUBMISSION_STATES.includes(from) || !LIVE_SUBMISSION_STATES.includes(to) || !TRANSITIONS[from]?.includes(to)) {
    throw Object.assign(new Error(`submission_transition_invalid:${from}:${to}`), { code: "SUBMISSION_TRANSITION_INVALID" });
  }
  return true;
}

export const isTerminalSubmissionState = state => TERMINAL.has(state);

const REQUIRED_GATES = Object.freeze([
  ["tenderActive", "TENDER_NOT_ACTIVE"], ["procedureEligible", "PROCEDURE_NOT_ELIGIBLE"],
  ["lotSelected", "LOT_NOT_SELECTED"], ["lotDeadlineExact", "LOT_DEADLINE_NOT_EXACT"],
  ["deadlineOpen", "DEADLINE_CLOSED"], ["deadlineTimezoneVerified", "DEADLINE_TIMEZONE_UNVERIFIED"],
  ["amendmentsCurrent", "AMENDMENT_REVIEW_REQUIRED"], ["portalResolved", "SUBMISSION_PORTAL_UNRESOLVED"],
  ["portalBindingExact", "PORTAL_BINDING_MISMATCH"], ["adapterProductionValidated", "ADAPTER_NOT_PRODUCTION_VALIDATED"],
  ["adapterSupportsSubmission", "BID_SUBMISSION_UNSUPPORTED"], ["credentialCurrent", "CREDENTIAL_VERSION_STALE"],
  ["credentialCompanyBound", "CREDENTIAL_COMPANY_MISMATCH"], ["portalSessionValid", "PORTAL_SESSION_INVALID"],
  ["portalMfaComplete", "PORTAL_MFA_REQUIRED"], ["companyScopeExact", "COMPANY_SCOPE_MISMATCH"],
  ["serviceScopeExact", "SERVICE_SCOPE_MISMATCH"], ["companyProfileComplete", "COMPANY_PROFILE_INCOMPLETE"],
  ["evidenceValid", "EVIDENCE_INVALID"], ["documentsDownloaded", "DOCUMENT_DOWNLOAD_INCOMPLETE"],
  ["malwareScanPassed", "MALWARE_SCAN_INCOMPLETE"], ["analysisComplete", "DOCUMENT_ANALYSIS_INCOMPLETE"],
  ["requirementsComplete", "REQUIREMENTS_INCOMPLETE"], ["calculationCurrent", "CALCULATION_STALE"],
  ["calculationTraceable", "CALCULATION_NOT_TRACEABLE"], ["bidPackageImmutable", "BID_PACKAGE_NOT_IMMUTABLE"],
  ["bidPackageComplete", "BID_PACKAGE_INCOMPLETE"], ["noPlaceholders", "PLACEHOLDERS_OR_TEST_DATA"],
  ["approvalExact", "APPROVAL_BINDING_MISMATCH"], ["fourEyesComplete", "FOUR_EYES_REQUIRED"],
  ["actorRoleValid", "SUBMISSION_ROLE_REQUIRED"], ["wbMfaCurrent", "WB_MFA_REQUIRED"],
  ["tenantScopeExact", "TENANT_SCOPE_MISMATCH"], ["rlsScopeExact", "RLS_SCOPE_MISMATCH"],
  ["entitlementActive", "BID_SUBMISSION_ENTITLEMENT_REQUIRED"], ["globalGateEnabled", "GLOBAL_SUBMISSION_GATE_DISABLED"],
  ["portalAllowlisted", "PORTAL_NOT_ALLOWLISTED"], ["globalKillSwitchOpen", "GLOBAL_KILL_SWITCH_ACTIVE"],
  ["portalKillSwitchOpen", "PORTAL_KILL_SWITCH_ACTIVE"], ["companyKillSwitchOpen", "COMPANY_KILL_SWITCH_ACTIVE"],
  ["noPriorAmbiguousAttempt", "PRIOR_SUBMISSION_UNCERTAIN"], ["noIdenticalReceipt", "IDENTICAL_SUBMISSION_EXISTS"],
  ["approvalAfterLiveGo", "NEW_POST_LIVE_APPROVAL_REQUIRED"],
]);

export function evaluateLiveSubmissionPrerequisites(input = {}) {
  const blockers = REQUIRED_GATES.filter(([field]) => input[field] !== true).map(([field, code]) => ({
    field, code, actionHref: input.blockerActions?.[code] || null,
  }));
  return Object.freeze({ ready: blockers.length === 0, status: blockers.length ? "NOT_READY" : "READY_FOR_APPROVAL", blockers });
}

export const RETRYABLE_BEFORE_COMMIT = new Set(["NETWORK_CONNECT", "NETWORK_RESET", "PORTAL_429", "PORTAL_5XX", "PORTAL_TEMPORARY_UNAVAILABLE", "SESSION_EXPIRED", "LEASE_LOST_BEFORE_COMMIT"]);

export function classifySubmissionFailure({ code = "UNKNOWN", phase, commitStarted = false, remoteCommitPossible = false, retryAfterSeconds = null } = {}) {
  const normalized = String(code).slice(0, 80);
  if (commitStarted || remoteCommitPossible || phase === "RECEIPT" || ["COMMIT_TIMEOUT", "RECEIPT_TIMEOUT", "REMOTE_STATUS_UNKNOWN"].includes(normalized)) {
    return Object.freeze({ state: "SUBMISSION_UNCERTAIN", retry: false, reconcile: true, code: normalized });
  }
  if (["PORTAL_REJECTED", "PACKAGE_REJECTED", "DEADLINE_CLOSED"].includes(normalized)) {
    return Object.freeze({ state: "REJECTED_BY_PORTAL", retry: false, reconcile: false, code: normalized });
  }
  const retry = (phase !== "COMMIT" || normalized === "LEASE_LOST_BEFORE_COMMIT") && RETRYABLE_BEFORE_COMMIT.has(normalized);
  return Object.freeze({ state: retry ? "FAILED_RETRYABLE" : "FAILED_FINAL", retry, reconcile: false, retryAfterSeconds, code: normalized });
}

export function retrySchedule({ attempt, maxAttempts = 4, now = Date.now(), retryAfterSeconds = null, seed = "" } = {}) {
  const current = Number(attempt);
  if (!Number.isSafeInteger(current) || current < 0 || current >= maxAttempts) return Object.freeze({ retry: false, retryAt: null });
  const floor = Number.isFinite(Number(retryAfterSeconds)) ? Math.max(0, Number(retryAfterSeconds) * 1000) : 0;
  const base = Math.min(15 * 60_000, 5_000 * (2 ** current));
  const jitter = Number.parseInt(liveSubmissionHash({ seed, current }).slice(0, 8), 16) % Math.max(1, Math.floor(base / 4));
  const delayMs = Math.max(floor, base + jitter);
  return Object.freeze({ retry: true, delayMs, retryAt: new Date(Number(now) + delayMs).toISOString() });
}

const SENSITIVE_KEY = /(password|secret|token|cookie|authorization|totp|recovery|storageState|sessionStorage|credentialPayload|credentialValue|payload)/i;
export function redactSubmissionValue(value, key = "") {
  if (SENSITIVE_KEY.test(key) || key.toLowerCase()==="credential") return "[REDACTED]";
  if (Array.isArray(value)) return value.map(item => redactSubmissionValue(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactSubmissionValue(item, name)]));
  return typeof value === "string" ? value.replace(/(?:bearer\s+|basic\s+)[a-z0-9._~+/=-]+/gi, "[REDACTED]").slice(0, 1000) : value;
}

const b64url = value => Buffer.from(value).toString("base64url");
export function createSubmissionContinuation(payload, secret, { now = Date.now(), ttlMs = 10 * 60_000 } = {}) {
  if (typeof secret !== "string" || secret.length < 32) throw Object.assign(new Error("continuation_secret_invalid"), { code: "CONTINUATION_SECRET_INVALID" });
  const body = { ...payload, purpose: "SUBMISSION_CONTINUATION", jti: crypto.randomUUID(), iat: Number(now), exp: Number(now) + ttlMs };
  const encoded = b64url(canonicalJson(body));
  const signature = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return Object.freeze({ token: `${encoded}.${signature}`, jtiHash: liveSubmissionHash(body.jti), expiresAt: new Date(body.exp).toISOString() });
}

export function verifySubmissionContinuation(token, secret, expected = {}, { now = Date.now() } = {}) {
  const [encoded, supplied, extra] = String(token || "").split(".");
  if (!encoded || !supplied || extra) throw Object.assign(new Error("continuation_invalid"), { code: "CONTINUATION_INVALID" });
  const signature = crypto.createHmac("sha256", secret).update(encoded).digest();
  const suppliedBuffer = Buffer.from(supplied, "base64url");
  if (signature.length !== suppliedBuffer.length || !crypto.timingSafeEqual(signature, suppliedBuffer)) throw Object.assign(new Error("continuation_signature_invalid"), { code: "CONTINUATION_INVALID" });
  const body = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (body.purpose !== "SUBMISSION_CONTINUATION" || !body.jti || Number(body.exp) <= Number(now)) throw Object.assign(new Error("continuation_expired"), { code: "CONTINUATION_EXPIRED" });
  for (const [key, value] of Object.entries(expected)) if (String(body[key] ?? "") !== String(value ?? "")) throw Object.assign(new Error(`continuation_scope_mismatch:${key}`), { code: "CONTINUATION_SCOPE_MISMATCH" });
  return Object.freeze({ ...body, jtiHash: liveSubmissionHash(body.jti) });
}

export const LEGAL_CONFIRMATION_TEXT = "Mit dieser Freigabe wird das Angebot nach Abschluss aller technischen Prüfungen rechtsverbindlich an das ausgewählte Vergabeportal übermittelt.";
