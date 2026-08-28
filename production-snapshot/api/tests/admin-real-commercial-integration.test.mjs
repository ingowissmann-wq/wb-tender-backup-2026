import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyAdminRequest, createCommercialTenancy, __test } from "../integrations/wb-admin-portal/candidate/commercial-tenancy.js";

test("real Admin routes map to canonical modules and unsafe stores fail closed", () => {
  const cases = [
    ["/api/admin/v1/resources/companies", "crm"],
    ["/api/admin/v1/resources/tasks?q=a", "flow"],
    ["/api/admin/v1/files/a/download", "docs"],
    ["/api/admin/v1/calculator/dashboard", "insights"],
    ["/api/admin/v1/iam/me", "control"],
  ];
  for (const [url, moduleKey] of cases) {
    const result = classifyAdminRequest("GET", url);
    assert.equal(result.disposition, "TENANT_BOUND", url);
    assert.equal(result.moduleKey, moduleKey, url);
  }
  assert.equal(classifyAdminRequest("GET", "/api/admin/v1/career/applications").disposition, "INTERNAL_ONLY");
  assert.equal(classifyAdminRequest("GET", "/api/admin/v1/iam/users").disposition, "BLOCKED");
  assert.equal(classifyAdminRequest("POST", "/api/service/v1/calculator/ingest").disposition, "BLOCKED");
  assert.equal(classifyAdminRequest("GET", "/api/admin/v1/unknown").disposition, "BLOCKED");
});

function replyRecorder() {
  return {
    statusCode: 200, body: null,
    code(value) { this.statusCode = value; return this; },
    send(value) { this.body = value; this.sent = true; return this; },
  };
}

function harness(state) {
  const contexts = [];
  const beginTenantQueryContext = async (req, { actorUserId }) => {
    const context = {
      client: {
        async query(sql) {
          if (sql.includes("FROM saas.tenant_memberships")) return { rowCount: state.memberships[actorUserId]?.length || 0, rows: state.memberships[actorUserId] || [] };
          if (sql.includes("FROM saas.modules")) return { rows: [...(state.modules[context.tenantId] || [])].map((module_key) => ({ module_key })) };
          throw new Error(`unexpected_query:${sql}`);
        },
      },
      async setTenant(id) { context.tenantId = id; },
    };
    req.tenantQueryContext = context;
    contexts.push(context);
    return context;
  };
  const finishTenantQueryContext = async (req, successful) => { req.finished = successful; delete req.tenantQueryContext; };
  return { gate: createCommercialTenancy({ pool: {}, beginTenantQueryContext, finishTenantQueryContext }), contexts };
}

test("two synthetic tenants isolate route entitlements and revocation is immediate", async () => {
  const previous = { enforced: process.env.WB_ADMIN_TENANCY_ENFORCED, saas: process.env.WB_ADMIN_SAAS_ENABLED, storage: process.env.WB_ADMIN_TENANT_FILE_STORAGE_ENABLED };
  process.env.WB_ADMIN_TENANCY_ENFORCED = "true";
  process.env.WB_ADMIN_SAAS_ENABLED = "true";
  process.env.WB_ADMIN_TENANT_FILE_STORAGE_ENABLED = "false";
  const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222";
  const state = {
    memberships: {
      userA: [{ tenant_id: a, role: "OWNER", tenant_kind: "CUSTOMER", status: "ACTIVE" }],
      userB: [{ tenant_id: b, role: "MEMBER", tenant_kind: "CUSTOMER", status: "ACTIVE" }],
    },
    modules: { [a]: new Set(["crm", "control"]), [b]: new Set(["flow", "control"]) },
  };
  const { gate } = harness(state);
  try {
    const reqA = { method: "GET", url: "/api/admin/v1/resources/companies", auth: { userId: "userA", permissions: ["iam.manage"] } }, replyA = replyRecorder();
    assert.equal(await gate.attach(reqA, replyA), true);
    assert.equal(reqA.auth.commercial.tenantId, a);
    assert.deepEqual(reqA.auth.permissions.sort(), ["crm.read", "crm.write"]);

    const reqB = { method: "GET", url: "/api/admin/v1/resources/companies", auth: { userId: "userB", permissions: ["iam.manage"] } }, replyB = replyRecorder();
    assert.equal(await gate.attach(reqB, replyB), false);
    assert.equal(replyB.statusCode, 403);
    assert.equal(replyB.body.error, "module_entitlement_required");

    state.modules[a].delete("crm");
    const revoked = { method: "GET", url: "/api/admin/v1/resources/companies", auth: { userId: "userA", permissions: [] } }, revokedReply = replyRecorder();
    assert.equal(await gate.attach(revoked, revokedReply), false);
    assert.equal(revokedReply.body.error, "module_entitlement_required");

    const docs = { method: "GET", url: "/api/admin/v1/files/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/download", auth: { userId: "userB", permissions: [] } }, docsReply = replyRecorder();
    state.modules[b].add("docs");
    assert.equal(await gate.attach(docs, docsReply), false);
    assert.equal(docsReply.statusCode, 503);
    assert.equal(docsReply.body.error, "tenant_storage_not_ready");

    const missing = { method: "GET", url: "/api/admin/v1/iam/me", auth: { userId: "unknown", permissions: [] } }, missingReply = replyRecorder();
    assert.equal(await gate.attach(missing, missingReply), false);
    assert.equal(missingReply.body.error, "tenant_context_required");
  } finally {
    if (previous.enforced === undefined) delete process.env.WB_ADMIN_TENANCY_ENFORCED; else process.env.WB_ADMIN_TENANCY_ENFORCED = previous.enforced;
    if (previous.saas === undefined) delete process.env.WB_ADMIN_SAAS_ENABLED; else process.env.WB_ADMIN_SAAS_ENABLED = previous.saas;
    if (previous.storage === undefined) delete process.env.WB_ADMIN_TENANT_FILE_STORAGE_ENABLED; else process.env.WB_ADMIN_TENANT_FILE_STORAGE_ENABLED = previous.storage;
  }
});

test("customer identities never inherit global IAM administration", () => {
  const modules = new Set(__test.ALL_MODULES);
  const permissions = __test.saasPermissions("OWNER", modules);
  assert.ok(permissions.includes("crm.read"));
  assert.ok(permissions.includes("calculator.read"));
  assert.ok(!permissions.includes("iam.manage"));
  assert.ok(!permissions.includes("audit.read"));
  assert.ok(!permissions.includes("sessions.manage"));
});

test("Admin migrations use staged guarded backfill, forced RLS, and reversible application-first rollback", async () => {
  const [columns, backfill, enforcement, rollback, dockerfile] = await Promise.all([
    readFile(new URL("../migrations/083_real_admin_portal_tenant_columns.sql", import.meta.url), "utf8"),
    readFile(new URL("../deployment/backfill-real-admin-internal-tenant.sql", import.meta.url), "utf8"),
    readFile(new URL("../migrations/084_real_admin_portal_tenant_enforcement.sql", import.meta.url), "utf8"),
    readFile(new URL("../deployment/rollback-real-admin-tenant-enforcement.sql", import.meta.url), "utf8"),
    readFile(new URL("../deployment/Dockerfile.admin-commercial-tenancy", import.meta.url), "utf8"),
  ]);
  for (const table of ["app.resources", "app.resource_files", "files.objects", "crm.documents", "recruiting.application_files", "audit.events"])
    assert.match(columns, new RegExp(`ALTER TABLE ${table.replace(".", "\\.")} ADD COLUMN IF NOT EXISTS tenant_id`));
  assert.match(backfill, /admin_source_manifest_mismatch/);
  assert.match(backfill, /tenant_kind='INTERNAL'/);
  assert.match(enforcement, /FORCE ROW LEVEL SECURITY/);
  assert.match(enforcement, /saas\.tenant_matches\(tenant_id\)/);
  assert.match(rollback, /wb_admin_saas_must_be_disabled/);
  assert.match(dockerfile, /WB_ADMIN_SAAS_ENABLED=false/);
  assert.match(dockerfile, /EXTERNAL_SUBMISSION_ENABLED=false/);
  assert.match(dockerfile, /WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false/);
});
