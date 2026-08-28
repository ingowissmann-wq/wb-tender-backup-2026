import crypto from "node:crypto";
import { submissionHash } from "./submission-framework.mjs";

export const BINDING_RELEASE_STATUSES = Object.freeze([
  "REQUESTED", "APPROVED", "REVOKED", "EXPIRED", "INVALIDATED",
]);

const text = (value) => String(value ?? "").trim();
const required = (condition, code) => {
  if (!condition) throw Object.assign(new Error(code), { code });
};

export function canonicalBindingReleaseScope(input = {}) {
  const scope = Object.freeze({
    companyId: text(input.companyId ?? input.company_id),
    credentialId: text(input.credentialId ?? input.credential_id),
    portalId: text(input.portalId ?? input.portal_id),
    tenderId: text(input.tenderId ?? input.tender_id),
    lotKey: text(input.lotKey ?? input.lot_key),
    bidPackageHash: text(input.bidPackageHash ?? input.bid_package_hash).toLowerCase(),
    managementApprovalId: text(input.managementApprovalId ?? input.management_approval_request_id),
  });
  required(scope.companyId && scope.credentialId && scope.portalId && scope.tenderId, "BINDING_RELEASE_SCOPE_INCOMPLETE");
  required(/^[a-f0-9]{64}$/.test(scope.bidPackageHash), "BINDING_RELEASE_PACKAGE_HASH_INVALID");
  required(scope.managementApprovalId, "BINDING_RELEASE_MANAGEMENT_APPROVAL_REQUIRED");
  return scope;
}

export const bindingReleaseHash = (input) => submissionHash(canonicalBindingReleaseScope(input));

export function validateBindingReleaseRequest(input = {}, { now = Date.now(), maxLifetimeMs = 2 * 60 * 60 * 1000 } = {}) {
  const scope = canonicalBindingReleaseScope(input), expiresAt = Date.parse(input.expiresAt ?? input.expires_at);
  required(Number.isFinite(expiresAt) && expiresAt > Number(now), "BINDING_RELEASE_EXPIRY_INVALID");
  required(expiresAt - Number(now) <= maxLifetimeMs, "BINDING_RELEASE_EXPIRY_TOO_LONG");
  return Object.freeze({ scope, bindingSha256: bindingReleaseHash(scope), expiresAt: new Date(expiresAt).toISOString(), transmitted: false });
}

export function effectiveBindingRelease(release = {}, current = {}, { now = Date.now() } = {}) {
  let status = BINDING_RELEASE_STATUSES.includes(release.status) ? release.status : "INVALIDATED", reason = null;
  if (status === "REQUESTED" || status === "APPROVED") {
    if (!release.expiresAt || Date.parse(release.expiresAt) <= Number(now)) { status = "EXPIRED"; reason = "BINDING_RELEASE_EXPIRED"; }
    else {
      const expected = canonicalBindingReleaseScope(release.scope || release);
      let actual;
      try { actual = canonicalBindingReleaseScope(current.scope || current); } catch { actual = null; }
      if (!actual || bindingReleaseHash(expected) !== bindingReleaseHash(actual)) { status = "INVALIDATED"; reason = "BINDING_RELEASE_CONTEXT_CHANGED"; }
    }
  }
  const approvedBy = text(release.approvedBy ?? release.approved_by), requestedBy = text(release.requestedBy ?? release.requested_by);
  const fourEyesValid = status === "APPROVED" && approvedBy && requestedBy && approvedBy !== requestedBy && release.managementApprovalValid === true;
  return Object.freeze({ status, reason, valid: fourEyesValid, fourEyesValid, external_submission_enabled: false, transmitted: false });
}

export function authorizeBindingReleaseApproval(release = {}, actor = {}, current = {}, options = {}) {
  const effective = effectiveBindingRelease(release, current, options);
  required(effective.status === "REQUESTED", effective.reason || "BINDING_RELEASE_NOT_REQUESTED");
  required(text(actor.userId) && text(actor.userId) !== text(release.requestedBy ?? release.requested_by), "BINDING_RELEASE_FOUR_EYES_REQUIRED");
  required(actor.managementAuthorized === true, "BINDING_RELEASE_MANAGEMENT_ROLE_REQUIRED");
  required(release.managementApprovalValid === true, "BINDING_RELEASE_MANAGEMENT_APPROVAL_INVALID");
  const supplied = text(actor.expectedBindingSha256).toLowerCase(), expected = bindingReleaseHash(release.scope || release);
  required(/^[a-f0-9]{64}$/.test(supplied) && crypto.timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex")), "BINDING_RELEASE_HASH_MISMATCH");
  return Object.freeze({ status: "APPROVED", approvedBy: text(actor.userId), bindingSha256: expected, external_submission_enabled: false, transmitted: false });
}

export function bindingReleaseGate(release, current, options) {
  const effective = effectiveBindingRelease(release, current, options);
  return Object.freeze({
    releasedForInternalFinalization: effective.valid,
    bindingExecutionAllowed: false,
    bindingExecutionHttpStatus: 423,
    blocker: effective.valid ? "EXTERNAL_SUBMISSION_LOCKED" : effective.reason || "BINDING_RELEASE_REQUIRED",
    external_submission_enabled: false,
    transmitted: false,
  });
}
