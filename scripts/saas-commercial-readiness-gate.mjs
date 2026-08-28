import { readFile } from "node:fs/promises";

const enabled = process.env.WB_TENDER_SAAS_ENABLED === "true";
const externalSubmission = process.env.EXTERNAL_SUBMISSION_ENABLED === "true" || process.env.WB_TENDER_ALLOW_EXTERNAL_SUBMISSION === "true";
if (externalSubmission) throw new Error("external_submission_must_remain_disabled");

const blockers = [];
const requireValue = (name, reason = name.toLowerCase() + "_missing") => {
  if (!String(process.env[name] || "").trim()) blockers.push(reason);
};
if (enabled) {
  if (process.env.WB_TENDER_TENANT_ISOLATION_VERIFIED !== "true") blockers.push("tenant_isolation_evidence_missing");
  if (process.env.WB_TENDER_WB_BACKFILL_VERIFIED !== "true") blockers.push("wb_internal_tenant_compatibility_missing");
  if (process.env.WB_ADMIN_SAAS_ENABLED !== "true") blockers.push("real_admin_saas_exposure_disabled");
  if (process.env.WB_ADMIN_TENANCY_ENFORCED !== "true") blockers.push("real_admin_tenancy_enforcement_disabled");
  if (process.env.WB_ADMIN_REAL_MODULE_ISOLATION_VERIFIED !== "true") blockers.push("real_admin_cross_tenant_evidence_missing");
  if (process.env.WB_TENDER_SAAS_LEGACY_API_ENABLED === "true") blockers.push("legacy_wb_data_plane_must_remain_forbidden");
  requireValue("WB_TENDER_RUNTIME_DB_ROLE", "least_privilege_runtime_role_missing");
  requireValue("WB_TENDER_TENANT_STORAGE_ADAPTER", "tenant_bound_storage_adapter_missing");
  if (process.env.SAAS_IAM_ADAPTER !== "oidc") blockers.push("saas_oidc_adapter_not_selected");
  for (const name of ["SAAS_IAM_ISSUER","SAAS_IAM_AUTHORIZATION_ENDPOINT","SAAS_IAM_TOKEN_ENDPOINT","SAAS_IAM_JWKS_URI","SAAS_IAM_CLIENT_ID"]) requireValue(name);
  for (const name of ["SAAS_IAM_CLIENT_SECRET","SAAS_IAM_SESSION_PEPPER"]) {
    if (process.env[name]) blockers.push(`${name.toLowerCase()}_inline_value_forbidden`);
    if (!String(process.env[`${name}_FILE`] || "").trim()) blockers.push(`${name.toLowerCase()}_file_missing`);
  }
  requireValue("SAAS_EMAIL_PROVIDER", "email_provider_missing");
  requireValue("SAAS_BILLING_PROVIDER", "payment_provider_missing");
  requireValue("SAAS_BILLING_ADAPTER", "concrete_payment_adapter_missing");
  requireValue("SAAS_EMAIL_ADAPTER", "concrete_email_adapter_missing");
  if (process.env.SAAS_BILLING_ADAPTER !== "stripe" || process.env.SAAS_BILLING_PROVIDER !== "stripe") blockers.push("stripe_adapter_not_selected");
  if (process.env.SAAS_EMAIL_ADAPTER !== "smtp") blockers.push("smtp_email_adapter_not_selected");
  if (process.env.WB_TENDER_TENANT_STORAGE_ADAPTER !== "filesystem") blockers.push("tenant_filesystem_storage_not_selected");
  for (const name of ["STRIPE_SECRET_KEY","STRIPE_WEBHOOK_SECRET","STRIPE_PRICE_CORE","STRIPE_PRICE_NORMAL","STRIPE_PRICE_PROFESSIONAL","WB_TENDER_PUBLIC_BASE_URL","SAAS_INVITATION_PEPPER"]) requireValue(name);
  for (const name of ["SAAS_SMTP_HOST","SAAS_SMTP_PORT","SAAS_SMTP_SECURE","SAAS_SMTP_USER","SAAS_SMTP_PASSWORD","SAAS_SMTP_FROM"]) {
    if (process.env[name]) blockers.push(`${name.toLowerCase()}_inline_value_forbidden`);
    if (!String(process.env[`${name}_FILE`] || "").trim()) blockers.push(`${name.toLowerCase()}_file_missing`);
  }
  requireValue("WB_TENDER_TERMS_URL", "approved_agb_terms_missing");
  requireValue("WB_TENDER_PRIVACY_URL", "approved_datenschutz_notice_missing");
  requireValue("WB_TENDER_IMPRINT_URL", "approved_impressum_missing");
  requireValue("WB_TENDER_DPA_URL", "approved_dsgvo_data_processing_terms_missing");
  if (process.env.WB_TENDER_LEGAL_APPROVED !== "true") blockers.push("legal_approval_missing");
  if (process.env.WB_TENDER_COMMERCIAL_PRICES_APPROVED !== "true") blockers.push("commercial_price_approval_missing");
  const migration = await readFile(new URL("../migrations/080_saas_product_entitlements.sql", import.meta.url), "utf8");
  if (!/price_status text NOT NULL DEFAULT 'PLACEHOLDER'/.test(migration)) blockers.push("catalog_price_safety_marker_missing");
  const isolation = await readFile(new URL("../migrations/081_tenant_data_plane.sql", import.meta.url), "utf8");
  if (!/FORCE ROW LEVEL SECURITY/.test(isolation) || !/saas\.tenant_matches\(tenant_id\)/.test(isolation)) blockers.push("mandatory_rls_missing");
  const modules = await readFile(new URL("../migrations/082_commercial_module_catalog.sql", import.meta.url), "utf8");
  if (!/commercial_scope IN\('BUNDLE','MODULES','SUITE'\)/.test(modules)) blockers.push("commercial_scope_contract_missing");
  if (!/module_entitlement_required/.test(modules) || !/claim_module_job/.test(modules)) blockers.push("worker_module_enforcement_missing");
  if (!/recommended_monthly_price_minor=NULL/.test(modules)) blockers.push("unapproved_placeholder_pricing_not_cleared");
  const adminColumns = await readFile(new URL("../migrations/083_real_admin_portal_tenant_columns.sql", import.meta.url), "utf8");
  const adminRls = await readFile(new URL("../migrations/084_real_admin_portal_tenant_enforcement.sql", import.meta.url), "utf8");
  const adminGate = await readFile(new URL("../integrations/wb-admin-portal/candidate/commercial-tenancy.js", import.meta.url), "utf8");
  if (!/admin_source_manifest/.test(adminColumns) || !/FORCE ROW LEVEL SECURITY/.test(adminRls)) blockers.push("real_admin_tenant_migrations_missing");
  if (!/saas_route_not_tenant_bound/.test(adminGate) || !/module_entitlement_required/.test(adminGate)) blockers.push("real_admin_module_gate_missing");
  const trialPlane = await readFile(new URL("../migrations/085_business_suite_trial_data_plane.sql", import.meta.url), "utf8");
  const storage = await readFile(new URL("../platform/tenant-storage.mjs", import.meta.url), "utf8");
  const adapters = await readFile(new URL("../platform/saas-adapters.mjs", import.meta.url), "utf8");
  if (!/csm_service_cases/.test(trialPlane) || !/people_onboarding_tasks/.test(trialPlane) || !/FORCE ROW LEVEL SECURITY/.test(trialPlane)) blockers.push("commercial_tenant_data_plane_incomplete");
  if (!/class TenantFilesystemStorage/.test(storage) || !/tenant_storage_path_escape/.test(storage)) blockers.push("tenant_storage_adapter_incomplete");
  if (!/class StripeBillingAdapter/.test(adapters) || !/payment_status === "paid"/.test(adapters) || !/class SmtpEmailAdapter/.test(adapters)) blockers.push("provider_adapters_incomplete");
}

if (blockers.length) {
  console.error(JSON.stringify({ passed: false, enabled, blockers, externalSubmissionEnabled: false }));
  process.exitCode = 2;
} else {
  console.log(JSON.stringify({ passed: true, enabled, externalSubmissionEnabled: false, note: enabled ? "configuration_present; provider-specific acceptance still required" : "saas feature flag remains off" }));
}
