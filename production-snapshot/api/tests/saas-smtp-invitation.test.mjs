import test from "node:test";
import assert from "node:assert/strict";
import { registerTenantPortalRoutes } from "../platform/tenant-portal.mjs";

const tenantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const invitationId = "33333333-3333-4333-8333-333333333333";

function harness(emailAdapter) {
  const routes = new Map();
  const app = {};
  for (const method of ["get", "post", "patch", "delete"]) app[method] = (path, _options, handler) => routes.set(`${method}:${path}`, handler);
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(String(sql));
      if (String(sql).includes("INSERT INTO saas.tenant_invitations")) return { rows: [{ id: invitationId, email: "invitee@example.invalid", role: "MEMBER", status: "PENDING", expires_at: new Date() }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client };
  registerTenantPortalRoutes(app, { pool, authenticate: async () => {}, csrf: async () => {}, invitationPepper: "isolated-invitation-pepper-over-32-characters", emailAdapter });
  const reply = { statusCode: 200, payload: null, code(value) { this.statusCode = value; return this; }, send(value) { this.payload = value; return value; } };
  const req = { body: { email: "invitee@example.invalid", role: "MEMBER" }, tenant: { id: tenantId }, identity: { userId, saas: { role: "ADMIN" } }, log: { warn() {} } };
  return { handler: routes.get("post:/api/tenant-portal/control/invitations"), queries, reply, req };
}

test("tenant invitation is returned only after its dedicated SaaS mail is accepted", async () => {
  let mail;
  const ctx = harness({ configured: true, async sendInvitation(value) { mail = value; return { accepted: true }; } });
  await ctx.handler(ctx.req, ctx.reply);
  assert.equal(ctx.reply.statusCode, 201);
  assert.equal(ctx.reply.payload.delivery, "QUEUED");
  assert.equal(mail.email, "invitee@example.invalid");
  assert.equal(mail.tenantId, tenantId);
  assert.ok(mail.token.length >= 32);
  assert.equal(ctx.queries.some((query) => query.includes("DELETE FROM saas.tenant_invitations")), false);
});

test("failed invitation delivery removes the unusable pending token and fails closed", async () => {
  const ctx = harness({ configured: true, async sendInvitation() { throw new Error("synthetic_delivery_failure"); } });
  await ctx.handler(ctx.req, ctx.reply);
  assert.equal(ctx.reply.statusCode, 503);
  assert.deepEqual(ctx.reply.payload, { error: "invitation_delivery_failed" });
  assert.equal(ctx.queries.some((query) => query.includes("DELETE FROM saas.tenant_invitations")), true);
});

test("unconfigured invitation mail fails before a database write", async () => {
  const ctx = harness({ configured: false });
  await ctx.handler(ctx.req, ctx.reply);
  assert.equal(ctx.reply.statusCode, 503);
  assert.deepEqual(ctx.reply.payload, { error: "invitation_delivery_not_configured" });
  assert.equal(ctx.queries.some((query) => query.includes("tenant_invitations")), false);
});

