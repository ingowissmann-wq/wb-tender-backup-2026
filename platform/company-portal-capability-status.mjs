const unsupportedValidationStatuses = new Set([
  "NEEDS_ADAPTER_IMPLEMENTATION",
  "NO_ACTIVE_TENDER_FOR_VALIDATION",
]);

export function hasConcreteAdapterImplementation(portal = {}) {
  const adapterId = String(portal.adapter_id || "").trim();
  return Boolean(adapterId) && !adapterId.startsWith("unknown-") &&
    !unsupportedValidationStatuses.has(String(portal.adapter_validation_status || ""));
}

export function classifyPortalFeatureGap(portal = {}, feature = null) {
  if (!hasConcreteAdapterImplementation(portal)) return "UNSUPPORTED_PORTAL_REQUIRES_ADAPTER";
  if (!feature || feature.portal_support !== "SUPPORTED" || feature.autopilot_supported !== true) {
    return "UNSUPPORTED_PORTAL_REQUIRES_ADAPTER";
  }
  return "ADAPTER_REPAIR_REQUIRED";
}

export function companyContextStatus(company = {}) {
  if (Number(company.tenant_count) !== 1) {
    return {
      status: "DATA_CONTEXT_REPAIR_REQUIRED",
      repair: "Aktive Gesellschaft eindeutig mit genau einem autoritativen Tenant verbinden.",
    };
  }
  const services = (company.canonical_services || []).filter(Boolean);
  if (Number(company.tender_scope_count) !== 1 || Number(company.scope_tenant_count) !== 1 ||
      services.length !== 1 || String(company.scope_tenant_id || "") !== String(company.tenant_id || "")) {
    return {
      status: "DATA_CONTEXT_REPAIR_REQUIRED",
      repair: "Autoritatives Tender-Profil mit genau einem Leistungsbereich und demselben Tenant wie die Gesellschaft freigeben.",
    };
  }
  return null;
}
