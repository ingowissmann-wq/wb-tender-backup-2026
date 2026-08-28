export const PLAN_CODES = Object.freeze(["CORE", "NORMAL", "PROFESSIONAL", "ENTERPRISE"]);
export const SUITE_PRODUCT_KEY = "wb_business_suite";

export const MODULE_KEYS = Object.freeze({
  TENDER_SCOUT: "tender_scout",
  TENDER_AUTOPILOT: "tender_autopilot",
  CRM: "crm",
  CSM: "csm",
  FLOW: "flow",
  PEOPLE: "people",
  DOCS: "docs",
  CONTROL: "control",
  INSIGHTS: "insights",
  CONNECT: "connect",
});

export const MODULE_CATALOG = Object.freeze([
  { key: MODULE_KEYS.TENDER_SCOUT, slug: "tender-scout", name: "WB Tender Scout", description: "Public tender discovery, search, filters, relevance, favorites, deadlines and alerts.", category: "Tender", status: "PARTIAL", dependencies: [], availableInPlans: ["CORE", "NORMAL", "PROFESSIONAL", "ENTERPRISE"] },
  { key: MODULE_KEYS.TENDER_AUTOPILOT, slug: "tender-autopilot", name: "WB Tender Autopilot", description: "Tender analysis, required documents, PDF/form handling, preflight, bid workflow and management inbox.", category: "Tender", status: "PARTIAL", dependencies: [MODULE_KEYS.TENDER_SCOUT, MODULE_KEYS.DOCS], availableInPlans: ["NORMAL", "PROFESSIONAL", "ENTERPRISE"] },
  { key: MODULE_KEYS.CRM, slug: "crm", name: "WB CRM", description: "Leads, accounts, contacts, opportunities and sales workflows.", category: "Customer", status: "SECURE_EMPTY_SHELL", dependencies: [], availableInPlans: ["PROFESSIONAL", "ENTERPRISE"] },
  { key: MODULE_KEYS.CSM, slug: "csm", name: "WB CSM", description: "Customer success and service, customer health, service cases, retention and customer development.", category: "Customer", status: "TENANT_OWNED", dependencies: [], availableInPlans: ["PROFESSIONAL", "ENTERPRISE"] },
  { key: MODULE_KEYS.FLOW, slug: "flow", name: "WB Flow", description: "Blocks, tasks, workflow and process automation, and internal process building blocks.", category: "Operations", status: "SECURE_EMPTY_SHELL", dependencies: [], availableInPlans: ["NORMAL", "PROFESSIONAL", "ENTERPRISE"] },
  { key: MODULE_KEYS.PEOPLE, slug: "people", name: "WB People", description: "Employee portal, employee data, onboarding and staff self-service.", category: "People", status: "TENANT_OWNED", dependencies: [], availableInPlans: ["NORMAL", "PROFESSIONAL", "ENTERPRISE"] },
  { key: MODULE_KEYS.DOCS, slug: "docs", name: "WB Docs", description: "Central documents and files, folders, controlled downloads and document workflows.", category: "Content", status: "TENANT_OWNED", dependencies: [], availableInPlans: ["NORMAL", "PROFESSIONAL", "ENTERPRISE"] },
  { key: MODULE_KEYS.CONTROL, slug: "control", name: "WB Control", description: "Administration, roles, permissions, settings, audit and tenant administration.", category: "Administration", status: "TENANT_ADMIN", dependencies: [], availableInPlans: ["CORE", "NORMAL", "PROFESSIONAL", "ENTERPRISE"] },
  { key: MODULE_KEYS.INSIGHTS, slug: "insights", name: "WB Insights", description: "Dashboards, reports and management analytics.", category: "Analytics", status: "SECURE_EMPTY_SHELL", dependencies: [], availableInPlans: ["PROFESSIONAL", "ENTERPRISE"] },
  { key: MODULE_KEYS.CONNECT, slug: "connect", name: "WB Connect", description: "API, integrations, SSO and enterprise connectors.", category: "Integration", status: "SECURE_EMPTY_SHELL", dependencies: [], availableInPlans: ["ENTERPRISE"] },
]);

export const BUNDLE_MODULES = Object.freeze({
  CORE: Object.freeze([MODULE_KEYS.TENDER_SCOUT, MODULE_KEYS.CONTROL]),
  NORMAL: Object.freeze([MODULE_KEYS.TENDER_SCOUT, MODULE_KEYS.TENDER_AUTOPILOT, MODULE_KEYS.FLOW, MODULE_KEYS.PEOPLE, MODULE_KEYS.DOCS, MODULE_KEYS.CONTROL]),
  PROFESSIONAL: Object.freeze([MODULE_KEYS.TENDER_SCOUT, MODULE_KEYS.TENDER_AUTOPILOT, MODULE_KEYS.CRM, MODULE_KEYS.CSM, MODULE_KEYS.FLOW, MODULE_KEYS.PEOPLE, MODULE_KEYS.DOCS, MODULE_KEYS.CONTROL, MODULE_KEYS.INSIGHTS]),
  ENTERPRISE: Object.freeze(Object.values(MODULE_KEYS)),
});

// Dependencies grant only the capabilities an entitled module needs. They do
// not grant navigation or direct HTTP access to the dependency module.
export const MODULE_CAPABILITIES = Object.freeze({
  [MODULE_KEYS.TENDER_SCOUT]: Object.freeze(["tender.public_discovery"]),
  [MODULE_KEYS.TENDER_AUTOPILOT]: Object.freeze(["tender.autopilot", "tender.public_discovery", "docs.object_storage"]),
  [MODULE_KEYS.CRM]: Object.freeze(["crm.workspace"]),
  [MODULE_KEYS.CSM]: Object.freeze(["csm.workspace"]),
  [MODULE_KEYS.FLOW]: Object.freeze(["flow.workspace"]),
  [MODULE_KEYS.PEOPLE]: Object.freeze(["people.workspace"]),
  [MODULE_KEYS.DOCS]: Object.freeze(["docs.object_storage"]),
  [MODULE_KEYS.CONTROL]: Object.freeze(["tenant.administration"]),
  [MODULE_KEYS.INSIGHTS]: Object.freeze(["insights.workspace"]),
  [MODULE_KEYS.CONNECT]: Object.freeze(["connect.workspace"]),
});

// 080/081 feature keys remain readable for migration compatibility. New code
// enforces canonical module keys and never treats a legacy feature as a grant.
export const FEATURE_KEYS = Object.freeze({
  DISCOVERY: "discovery.public", SAVED_SEARCHES: "discovery.saved_searches", ALERTS: "discovery.alerts",
  DEADLINES: "workflow.deadlines", DASHBOARD: "dashboard.basic", AI_RELEVANCE: "analysis.ai_relevance",
  DOCUMENT_ANALYSIS: "analysis.documents", REQUIRED_DOCUMENTS: "workflow.required_documents", PDF_EDITOR: "workflow.pdf_editor",
  TASKS: "workflow.tasks", AUTOPILOT: "autopilot.workflows", PORTAL_RETRIEVAL: "portal.authorized_retrieval",
  MANAGEMENT_INBOX: "workflow.management_inbox", PREFLIGHT: "workflow.preflight", BID_PACKAGE: "workflow.bid_package",
  ADVANCED_ANALYTICS: "analytics.advanced", ADVANCED_RBAC: "iam.advanced_rbac", AUDIT_EXPORT: "audit.export",
  API: "integration.api", SSO: "iam.sso_ready",
});

export const BILLING_STATES = Object.freeze(["PENDING_PAYMENT", "TRIAL_ACTIVE", "TRIAL_EXPIRED", "ACTIVE", "PAST_DUE", "SUSPENDED", "CANCELED"]);

export function normalizePlanCode(value) {
  const code = String(value || "").trim().toUpperCase();
  if (!PLAN_CODES.includes(code)) throw Object.assign(new Error("plan_invalid"), { statusCode: 400 });
  return code;
}

export function normalizeModuleKey(value) {
  const key = String(value || "").trim().toLowerCase().replaceAll("-", "_");
  if (!Object.values(MODULE_KEYS).includes(key)) throw Object.assign(new Error("module_invalid"), { statusCode: 400 });
  return key;
}

export function effectiveAccess(subscription, now = new Date()) {
  if (!subscription) return { allowed: false, reason: "subscription_missing" };
  if (subscription.tenant_status && subscription.tenant_status !== "ACTIVE")
    return { allowed: false, reason: subscription.tenant_status === "SUSPENDED" ? "tenant_suspended" : "tenant_activation_pending" };
  if (subscription.membership_status && subscription.membership_status !== "ACTIVE") return { allowed: false, reason: "membership_inactive" };
  if (subscription.status === "SUSPENDED") return { allowed: false, reason: "tenant_suspended" };
  if (subscription.status === "TRIAL_ACTIVE") {
    if (!subscription.trial_ends_at || new Date(subscription.trial_ends_at) <= now) return { allowed: false, reason: "trial_expired" };
    return { allowed: true, reason: "trial_active" };
  }
  if (subscription.status === "ACTIVE") {
    if (subscription.current_period_ends_at && new Date(subscription.current_period_ends_at) <= now)
      return { allowed: false, reason: "subscription_expired" };
    return { allowed: true, reason: "subscription_active" };
  }
  return { allowed: false, reason: String(subscription.status || "subscription_inactive").toLowerCase() };
}

export function resolveModuleEntitlements({ planCode, commercialScope = "BUNDLE", suiteEnabled = false, grants = [] } = {}) {
  const scope = String(commercialScope || "BUNDLE").toUpperCase();
  const enabled = new Set(suiteEnabled || scope === "SUITE" ? Object.values(MODULE_KEYS) : scope === "BUNDLE" ? (BUNDLE_MODULES[String(planCode || "").toUpperCase()] || []) : []);
  for (const grant of grants || []) {
    if (!Object.values(MODULE_KEYS).includes(grant.module_key)) continue;
    if (grant.enabled) enabled.add(grant.module_key); else enabled.delete(grant.module_key);
  }
  return Object.freeze([...enabled]);
}

export function moduleAccess(context, moduleKey, now = new Date()) {
  const key = normalizeModuleKey(moduleKey);
  const access = context?.access || effectiveAccess(context, now);
  if (!access.allowed) return { allowed: false, reason: access.reason, module: key };
  return (context.modules || []).includes(key)
    ? { allowed: true, reason: "module_entitled", module: key }
    : { allowed: false, reason: "module_not_entitled", module: key };
}

export function technicalCapabilities(context) {
  return Object.freeze([...new Set((context?.modules || []).flatMap((key) => MODULE_CAPABILITIES[key] || []))]);
}

export function navigationCatalog(context) {
  return MODULE_CATALOG.filter((module) => moduleAccess(context, module.key).allowed).map((module) => ({ ...module, uiPath: `/saas/app/${module.slug}`, apiPath: `/api/tenant-portal/modules/${module.slug}` }));
}

export function transitionSubscription(current, event, now = new Date()) {
  const status = current?.status || "PENDING_PAYMENT";
  if (event.type === "PAYMENT_CONFIRMED") {
    if (status !== "PENDING_PAYMENT") throw new Error("billing_transition_invalid");
    if (current.trial_claimed_at) throw new Error("trial_already_claimed");
    const trialEnds = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    return { status: "TRIAL_ACTIVE", trialStartedAt: now, trialEndsAt: trialEnds, trialClaimedAt: now };
  }
  if (event.type === "TRIAL_EXPIRED" && status === "TRIAL_ACTIVE") return { status: "TRIAL_EXPIRED" };
  if (event.type === "SUBSCRIPTION_ACTIVATED" && ["TRIAL_ACTIVE", "TRIAL_EXPIRED", "PAST_DUE"].includes(status)) return { status: "ACTIVE" };
  if (event.type === "PAYMENT_FAILED" && ["TRIAL_ACTIVE", "ACTIVE"].includes(status)) return { status: "PAST_DUE" };
  if (event.type === "SUSPEND" && status !== "CANCELED") return { status: "SUSPENDED" };
  if (event.type === "REACTIVATE" && status === "SUSPENDED") {
    if (current.trial_ends_at && new Date(current.trial_ends_at) > now) return { status: "TRIAL_ACTIVE" };
    if (current.trial_claimed_at) return { status: "TRIAL_EXPIRED" };
    if (current.current_period_ends_at && new Date(current.current_period_ends_at) > now) return { status: "ACTIVE" };
    return { status: "PENDING_PAYMENT" };
  }
  if (event.type === "CANCEL" && status !== "CANCELED") return { status: "CANCELED" };
  throw new Error("billing_transition_invalid");
}

export function assessPlanChange(current, next, usage = {}) {
  if (!current || !next) throw new Error("plan_catalog_entry_missing");
  const seats = Number(usage.seats || 0), companies = Number(usage.companies || 0);
  if (next.seat_limit != null && seats > Number(next.seat_limit)) return { allowed: false, reason: "seat_limit_exceeded", required: seats, limit: Number(next.seat_limit) };
  if (next.company_limit != null && companies > Number(next.company_limit)) return { allowed: false, reason: "company_limit_exceeded", required: companies, limit: Number(next.company_limit) };
  return { allowed: true, direction: Number(next.position) > Number(current.position) ? "UPGRADE" : Number(next.position) < Number(current.position) ? "DOWNGRADE" : "UNCHANGED" };
}

export function resolveEntitlement(rows, featureKey) {
  const row = (rows || []).find((item) => item.feature_key === featureKey);
  return row ? { enabled: Boolean(row.enabled), limit: row.limit_value == null ? null : Number(row.limit_value) } : { enabled: false, limit: null };
}
