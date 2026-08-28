const ALL_MODULES = [
  "tender_scout", "tender_autopilot", "crm", "csm", "flow",
  "people", "docs", "control", "insights", "connect",
];

const RESOURCE_MODULE = Object.freeze({
  companies: "crm", contacts: "crm", leads: "crm", opportunities: "crm",
  pipelines: "crm", activities: "crm",
  tasks: "flow", reminders: "flow", notes: "flow", appointments: "flow",
  documents: "docs",
  calculator_records: "insights",
});

const INTERNAL_ONLY_PREFIXES = [
  "/api/admin/v1/career/",
  "/api/admin/v1/autoseo/",
  "/api/public/",
  "/admin/cms/",
  "/admin/recruiting/",
];

const UNBOUND_CONTROL_PREFIXES = [
  "/api/admin/v1/iam/users",
  "/api/admin/v1/resources/users",
  "/api/admin/v1/resources/roles",
  "/api/admin/v1/resources/sessions",
  "/api/admin/v1/audit",
  "/api/admin/v1/trash",
  "/api/admin/v1/categories/security/",
];

function pathname(value) {
  try { return new URL(value, "http://candidate.invalid").pathname; }
  catch { return String(value || "").split("?")[0]; }
}

export function classifyAdminRequest(method, rawUrl) {
  const path = pathname(rawUrl);
  if (path === "/api/admin/v1/iam/me" || path === "/api/admin/v1/iam/logout") {
    return { moduleKey: "control", disposition: "TENANT_BOUND" };
  }
  if (INTERNAL_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return { disposition: "INTERNAL_ONLY", reason: "shared_internal_store" };
  }
  if (UNBOUND_CONTROL_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return { moduleKey: "control", disposition: "BLOCKED", reason: "cross_tenant_control_plane_not_adapted" };
  }
  if (path.startsWith("/api/service/")) {
    return { moduleKey: "connect", disposition: "BLOCKED", reason: "service_call_missing_tenant_binding" };
  }
  if (path.startsWith("/api/admin/v1/files") || /\/files\.zip$/.test(path)) {
    return { moduleKey: "docs", disposition: "TENANT_BOUND", storage: true };
  }
  if (/\/export\.(csv|pdf)$/.test(path)) {
    const type = path.match(/\/resources\/([^/]+)\//)?.[1];
    return RESOURCE_MODULE[type]
      ? { moduleKey: RESOURCE_MODULE[type], disposition: "TENANT_BOUND" }
      : { disposition: "BLOCKED", reason: "export_type_not_mapped" };
  }
  const resourceType = path.match(/\/api\/admin\/v1\/resources\/([^/?]+)/)?.[1];
  if (resourceType) {
    return RESOURCE_MODULE[resourceType]
      ? { moduleKey: RESOURCE_MODULE[resourceType], disposition: "TENANT_BOUND" }
      : { disposition: "INTERNAL_ONLY", reason: "resource_type_not_commercialized" };
  }
  if (path.startsWith("/api/admin/v1/calculator") || path.startsWith("/admin/crm/calculator")) {
    return { moduleKey: "insights", disposition: "TENANT_BOUND" };
  }
  const adminCrmType = path.match(/^\/admin\/crm\/([^/?]+)/)?.[1];
  if (adminCrmType) {
    return RESOURCE_MODULE[adminCrmType]
      ? { moduleKey: RESOURCE_MODULE[adminCrmType], disposition: "TENANT_BOUND" }
      : { moduleKey: "crm", disposition: "TENANT_BOUND" };
  }
  if (path === "/admin/crm/" || path.startsWith("/api/admin/v1/categories/crm/")) {
    return { moduleKey: "crm", disposition: "TENANT_BOUND" };
  }
  if (path.startsWith("/admin/security/")) {
    return { moduleKey: "control", disposition: "BLOCKED", reason: "cross_tenant_control_plane_not_adapted" };
  }
  return { disposition: "BLOCKED", reason: "route_not_tenant_bound" };
}

function saasPermissions(role, modules) {
  if (role === "BILLING") return [];
  const write = role === "OWNER" || role === "ADMIN" || role === "MEMBER";
  const permissions = new Set();
  if (modules.has("crm")) permissions.add("crm.read");
  if (modules.has("flow")) permissions.add("crm.read");
  if (modules.has("docs")) permissions.add("files.private.read");
  if (modules.has("insights")) permissions.add("calculator.read");
  if (write && modules.has("crm")) permissions.add("crm.write");
  if (write && modules.has("flow")) permissions.add("crm.write");
  if (write && modules.has("insights")) permissions.add("calculator.write");
  return [...permissions];
}

export function createCommercialTenancy({ pool, beginTenantQueryContext, finishTenantQueryContext }) {
  const tenancyEnforced = () => String(process.env.WB_ADMIN_TENANCY_ENFORCED).toLowerCase() === "true";
  const saasEnabled = () => String(process.env.WB_ADMIN_SAAS_ENABLED).toLowerCase() === "true";

  async function openInternalRoute(req, reply) {
    if (!tenancyEnforced() || req.tenantQueryContext) return;
    const path = pathname(req.url);
    if (!path.startsWith("/api/public/") && !path.startsWith("/cms-media/") && !path.startsWith("/api/service/")) return;
    const tenantId = String(process.env.WB_INTERNAL_TENANT_ID || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
      reply.code(503).send({ error: "internal_tenant_context_not_configured" });
      return;
    }
    const context = await beginTenantQueryContext(req, { actorUserId: process.env.WB_INTERNAL_SERVICE_ACTOR_ID || "" });
    await context.setTenant(tenantId);
  }

  async function attach(req, reply) {
    if (!tenancyEnforced() || req.auth?.commercial) return true;
    const context = await beginTenantQueryContext(req, { actorUserId: req.auth.userId });
    try {
      const memberships = await context.client.query(`
        SELECT m.tenant_id,m.role,t.tenant_kind,t.status
        FROM saas.tenant_memberships m JOIN saas.tenants t ON t.id=m.tenant_id
        WHERE m.user_id=$1 AND m.status='ACTIVE' AND t.status='ACTIVE'
        ORDER BY m.tenant_id`, [req.auth.userId]);
      if (memberships.rowCount !== 1) {
        await finishTenantQueryContext(req, false);
        reply.code(403).send({ error: "tenant_context_required" });
        return false;
      }
      const identity = memberships.rows[0];
      await context.setTenant(identity.tenant_id);
      if (identity.tenant_kind === "INTERNAL") {
        req.auth.commercial = { tenantId: identity.tenant_id, tenantKind: "INTERNAL", modules: ALL_MODULES };
        return true;
      }
      if (!saasEnabled()) {
        reply.code(403).send({ error: "saas_disabled" });
        return false;
      }
      const entitlementRows = await context.client.query(`
        SELECT m.module_key
        FROM saas.modules m
        WHERE m.active AND saas.module_entitled($1,m.module_key,now())
        ORDER BY m.module_key`, [identity.tenant_id]);
      const modules = new Set(entitlementRows.rows.map((row) => row.module_key));
      const classification = classifyAdminRequest(req.method, req.url);
      if (classification.disposition !== "TENANT_BOUND") {
        reply.code(403).send({ error: "saas_route_not_tenant_bound", reason: classification.reason });
        return false;
      }
      if (!modules.has(classification.moduleKey)) {
        reply.code(403).send({ error: "module_entitlement_required", module: classification.moduleKey });
        return false;
      }
      if (classification.storage && String(process.env.WB_ADMIN_TENANT_FILE_STORAGE_ENABLED).toLowerCase() !== "true") {
        reply.code(503).send({ error: "tenant_storage_not_ready" });
        return false;
      }
      req.auth.permissions = saasPermissions(identity.role, modules);
      req.auth.commercial = {
        tenantId: identity.tenant_id,
        tenantKind: "CUSTOMER",
        role: identity.role,
        modules: [...modules].sort(),
      };
      return true;
    } catch (error) {
      await finishTenantQueryContext(req, false);
      throw error;
    }
  }

  async function finish(req, successful) {
    if (req.tenantQueryContext) await finishTenantQueryContext(req, successful);
  }

  function navigation(req) {
    const commercial = req.auth?.commercial;
    return commercial ? { saas: commercial.tenantKind === "CUSTOMER", tenantId: commercial.tenantId, modules: commercial.modules } : {};
  }

  return { attach, openInternalRoute, finish, navigation };
}

export const __test = { ALL_MODULES, RESOURCE_MODULE, saasPermissions };
