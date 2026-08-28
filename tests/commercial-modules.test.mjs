import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import {
  BUNDLE_MODULES, MODULE_CATALOG, MODULE_KEYS, SUITE_PRODUCT_KEY, moduleAccess,
  navigationCatalog, resolveModuleEntitlements, technicalCapabilities,
} from "../platform/saas-catalog.mjs";
import { requireSaasJobModule, requireSaasModule } from "../platform/saas-platform.mjs";
import { claimTenantModuleJob, registerTenantPortalRoutes } from "../platform/tenant-portal.mjs";

const tenantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const active = (modules) => ({ tenant_id: tenantId, plan_code: "CORE", status: "ACTIVE", tenant_status: "ACTIVE", membership_status: "ACTIVE", access: { allowed: true }, modules });

test("canonical catalog and exact bundle inheritance are stable", () => {
  assert.equal(MODULE_CATALOG.length, 10);
  assert.deepEqual(MODULE_CATALOG.map((module) => module.name), ["WB Tender Scout","WB Tender Autopilot","WB CRM","WB CSM","WB Flow","WB People","WB Docs","WB Control","WB Insights","WB Connect"]);
  assert.deepEqual(BUNDLE_MODULES.CORE, ["tender_scout", "control"]);
  assert.deepEqual(BUNDLE_MODULES.NORMAL, ["tender_scout", "tender_autopilot", "flow", "people", "docs", "control"]);
  assert.equal(BUNDLE_MODULES.PROFESSIONAL.includes("insights"), true);
  assert.deepEqual(BUNDLE_MODULES.ENTERPRISE, Object.values(MODULE_KEYS));
  assert.equal(SUITE_PRODUCT_KEY, "wb_business_suite");
});

test("individual module grants, suite, and explicit revocation resolve tenant-specifically", () => {
  assert.deepEqual(resolveModuleEntitlements({ planCode: "CORE", commercialScope: "MODULES", grants: [{ module_key: "control", enabled: true }, { module_key: "crm", enabled: true }] }), ["control", "crm"]);
  assert.equal(resolveModuleEntitlements({ planCode: "CORE", suiteEnabled: true }).length, 10);
  const revoked = resolveModuleEntitlements({ planCode: "ENTERPRISE", suiteEnabled: true, grants: [{ module_key: "connect", enabled: false }] });
  assert.equal(revoked.includes("connect"), false);
  assert.equal(revoked.length, 9);
});

test("trial expiry and missing tenant fail closed with 403 module guards", async () => {
  const replies = [];
  const reply = { sent: false, code(value) { this.status = value; return this; }, send(value) { this.sent = true; replies.push(value); return value; } };
  await requireSaasModule("crm")({ identity: { saas: { tenant_id: tenantId, plan_code: "CORE", access: { allowed: false, reason: "trial_expired" }, modules: ["crm"] } } }, reply);
  assert.equal(reply.status, 403); assert.equal(replies[0].error, "trial_expired");
  const missingReply = { sent: false, code(value) { this.status = value; return this; }, send(value) { this.sent = true; this.body = value; return value; } };
  await requireSaasModule("crm")({ identity: { saas: null } }, missingReply);
  assert.equal(missingReply.status, 403); assert.equal(missingReply.body.error, "tenant_context_required");
});

test("navigation hides disabled modules and dependencies grant capabilities without module exposure", () => {
  const autopilotOnly = active(["tender_autopilot", "control"]);
  assert.deepEqual(navigationCatalog(autopilotOnly).map((module) => module.key), ["tender_autopilot", "control"]);
  assert.equal(technicalCapabilities(autopilotOnly).includes("tender.public_discovery"), true);
  assert.equal(technicalCapabilities(autopilotOnly).includes("docs.object_storage"), true);
  assert.equal(moduleAccess(autopilotOnly, "tender_scout").allowed, false);
  assert.equal(moduleAccess(autopilotOnly, "docs").allowed, false);
});

test("direct disabled route is denied before protected module data is queried", async () => {
  let queryCount = 0;
  const pool = { query: async () => { queryCount += 1; return { rows: [] }; }, connect: async () => { throw new Error("protected_query_reached"); } };
  const app = Fastify();
  const authenticate = async (req) => { req.identity = { userId, saas: active(["control"]) }; };
  registerTenantPortalRoutes(app, { pool, authenticate, csrf: async () => {} });
  const response = await app.inject({ method: "GET", url: "/api/tenant-portal/modules/tender-scout" });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, "module_not_entitled");
  assert.equal(queryCount, 0);
  await app.close();
});

test("worker/job entitlement is checked before a database claim", async () => {
  let connections = 0;
  const pool = { connect: async () => { connections += 1; throw new Error("should_not_connect"); } };
  const context = { saas: active(["control"]), tenant: { id: tenantId, actorUserId: userId } };
  await assert.rejects(() => claimTenantModuleJob(pool, context, "33333333-3333-4333-8333-333333333333", "crm"), /module_not_entitled/);
  assert.equal(connections, 0);
  assert.equal(requireSaasJobModule({ saas: context.saas }, "crm").allowed, false);
});

test("migration enforces RLS, active lifecycle, suite, revocation and guarded job claims", async () => {
  const sql = await readFile(new URL("../migrations/082_commercial_module_catalog.sql", import.meta.url), "utf8");
  assert.match(sql, /tenant_module_entitlements ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /tenant_module_entitlements FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /s\.status='TRIAL_ACTIVE' AND s\.trial_ends_at>at_time/);
  assert.match(sql, /tenant_product_entitlements/);
  assert.match(sql, /coalesce\(\s*\(SELECT enabled FROM explicit\)/s);
  assert.match(sql, /claim_module_job/);
  assert.match(sql, /module_entitlement_required/);
  assert.match(sql, /exposes_required_module boolean NOT NULL DEFAULT false CHECK\(exposes_required_module=false\)/);
});

test("legacy WB behavior remains separate and SaaS identities cannot enter legacy routes", async () => {
  const server = await readFile(new URL("../platform/server.mjs", import.meta.url), "utf8");
  assert.match(server, /if \(req\.identity\.saas\)/);
  assert.match(server, /saas_legacy_data_plane_forbidden/);
  assert.match(server, /if \(!identity\.saas\)/);
});
