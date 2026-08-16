const value = input => String(input ?? "");

export function canonicalPortalScope(input = {}) {
  return Object.freeze({
    tenderId: value(input.tenderId ?? input.tender_id),
    companyId: value(input.companyId ?? input.company_id),
    portalId: value(input.portalId ?? input.portal_id),
    credentialId: value(input.credentialId ?? input.credential_id),
    sessionId: value(input.sessionId ?? input.session_id),
    lotKey: value(input.lotKey ?? input.lot_key),
  });
}

export function samePortalScope(left, right, { sessionOptional = false } = {}) {
  const a = canonicalPortalScope(left), b = canonicalPortalScope(right);
  return ["tenderId", "companyId", "portalId", "credentialId", "lotKey"].every(
    key => a[key] && a[key] === b[key],
  ) && (sessionOptional ? !a.sessionId || !b.sessionId || a.sessionId === b.sessionId : a.sessionId && a.sessionId === b.sessionId);
}

export function requirePortalScope(input = {}) {
  const scope = canonicalPortalScope(input);
  const missing = ["tenderId", "companyId", "portalId", "credentialId"].filter(key => !scope[key]);
  if (missing.length) throw Object.assign(new Error("PORTAL_SCOPE_INCOMPLETE"), { code: "PORTAL_SCOPE_INCOMPLETE", missing });
  return scope;
}
