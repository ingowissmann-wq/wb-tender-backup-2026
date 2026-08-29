import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { SignedBillingAdapter, SmtpEmailAdapter, customerIdentityHash, hashVerificationToken } from "../platform/saas-adapters.mjs";
import { assessPlanChange, effectiveAccess, resolveEntitlement, transitionSubscription } from "../platform/saas-catalog.mjs";
import { enforceSaasPermission, registerPendingTenant, SAAS_PERMISSION_FEATURES } from "../platform/saas-platform.mjs";

test("paid trial remains locked until a signed payment event", () => {
  const pending = { status: "PENDING_PAYMENT", trial_claimed_at: null };
  assert.equal(effectiveAccess(pending).allowed, false);
  const now = new Date("2026-08-17T12:00:00Z");
  const next = transitionSubscription(pending, { type: "PAYMENT_CONFIRMED" }, now);
  assert.equal(next.status, "TRIAL_ACTIVE");
  assert.equal(next.trialEndsAt.toISOString(), "2026-08-31T12:00:00.000Z");
});

test("synthetic provider webhook requires a valid constant-time signature", () => {
  const secret = "synthetic-test-only-webhook-secret-000000000";
  const body = Buffer.from(JSON.stringify({ id: "evt_1", type: "payment.confirmed", tenantId: "11111111-1111-4111-8111-111111111111" }));
  const adapter = new SignedBillingAdapter({ webhookSecret: secret, provider: "synthetic-test" });
  assert.throws(() => adapter.verifyWebhook(body, "00"), /signature_invalid/);
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(adapter.verifyWebhook(body, signature).type, "payment.confirmed");
});

test("expired trials lock access and a customer identity can claim only once", () => {
  const expired = { status: "TRIAL_ACTIVE", trial_ends_at: "2026-08-16T00:00:00Z" };
  assert.deepEqual(effectiveAccess(expired, new Date("2026-08-17T00:00:00Z")), { allowed: false, reason: "trial_expired" });
  assert.throws(() => transitionSubscription({ status: "PENDING_PAYMENT", trial_claimed_at: new Date() }, { type: "PAYMENT_CONFIRMED" }), /trial_already_claimed/);
  const pepper = "test-verification-pepper-with-more-than-32-characters";
  assert.equal(customerIdentityHash(" Owner@Example.com ", pepper), customerIdentityHash("owner@example.com", pepper));
  assert.equal(hashVerificationToken("token", pepper).includes("token"), false);
});

test("pending tenants and memberships stay locked even with a nominal active subscription", () => {
  assert.equal(effectiveAccess({ status: "ACTIVE", tenant_status: "PENDING", membership_status: "ACTIVE" }).reason, "tenant_activation_pending");
  assert.equal(effectiveAccess({ status: "ACTIVE", tenant_status: "ACTIVE", membership_status: "SUSPENDED" }).reason, "membership_inactive");
});

test("SaaS SMTP links keep credentials out of URLs and tokens out of server requests", () => {
  const adapter = new SmtpEmailAdapter({
    host: "127.0.0.1",
    from: "saas@example.invalid",
    verificationBaseUrl: "https://saas.example.invalid",
  });
  const verification = adapter.verificationUrl("verification-token");
  const invitation = adapter.invitationUrl({ tenantId: "11111111-1111-4111-8111-111111111111", token: "invitation-token" });
  assert.equal(verification, "https://saas.example.invalid/saas/verify#verification-token");
  assert.equal(invitation, "https://saas.example.invalid/saas/invitation#tenantId=11111111-1111-4111-8111-111111111111&token=invitation-token");
  assert.doesNotMatch(`${verification}${invitation}`, /smtp|password|username/i);
});

test("suspension reactivation never invents paid status", () => {
  assert.equal(transitionSubscription({ status: "SUSPENDED" }, { type: "REACTIVATE" }).status, "PENDING_PAYMENT");
  assert.equal(transitionSubscription({ status: "SUSPENDED", trial_claimed_at: new Date(), trial_ends_at: "2026-01-01" }, { type: "REACTIVATE" }, new Date("2026-08-17")).status, "TRIAL_EXPIRED");
});

test("plan upgrades pass and downgrades fail when seat or company usage exceeds limits", () => {
  const core = { code: "CORE", position: 10, seat_limit: 1, company_limit: 1 };
  const professional = { code: "PROFESSIONAL", position: 30, seat_limit: 10, company_limit: 3 };
  assert.deepEqual(assessPlanChange(core, professional, { seats: 1, companies: 1 }), { allowed: true, direction: "UPGRADE" });
  assert.equal(assessPlanChange(professional, core, { seats: 4, companies: 2 }).reason, "seat_limit_exceeded");
  assert.equal(assessPlanChange(professional, { ...core, seat_limit: 10 }, { seats: 4, companies: 2 }).reason, "company_limit_exceeded");
});

test("entitlement and RBAC checks fail closed for SaaS users", () => {
  const identity = { saas: { tenant_id: "11111111-1111-4111-8111-111111111111", access: { allowed: true }, plan_code: "CORE", modules: ["tender_scout"] } };
  assert.equal(enforceSaasPermission(identity, "tender.view_assigned").allowed, true);
  assert.equal(enforceSaasPermission(identity, "tender.task.manage").error, "module_not_entitled");
  assert.equal(enforceSaasPermission(identity, "tender.admin").error, "saas_permission_not_available");
  assert.equal(resolveEntitlement(identity.saas.entitlements, "unknown").enabled, false);
  assert.equal(SAAS_PERMISSION_FEATURES["tender.view_assigned"], "tender_scout");
});

test("migration establishes tenant isolation, one-trial, limits, and provider idempotency", async () => {
  const sql = await readFile(new URL("../migrations/080_saas_product_entitlements.sql", import.meta.url), "utf8");
  assert.match(sql, /customer_identity_hash text PRIMARY KEY/);
  assert.match(sql, /tenant_id uuid NOT NULL REFERENCES saas\.tenants/);
  assert.match(sql, /PRIMARY KEY\(provider,provider_event_id\)/);
  assert.match(sql, /saas_plan_limit_exceeded/);
  assert.match(sql, /trial_ends_at=trial_started_at\+interval '14 days'/);
  assert.match(sql, /REVOKE ALL ON SCHEMA saas FROM PUBLIC/);
});

test("plan catalog is data driven and upgrades never enable external submission", async () => {
  const sql = await readFile(new URL("../migrations/080_saas_product_entitlements.sql", import.meta.url), "utf8");
  const routes = await readFile(new URL("../platform/autopilot-routes.mjs", import.meta.url), "utf8");
  for (const plan of ["CORE", "NORMAL", "PROFESSIONAL", "ENTERPRISE"]) assert.match(sql, new RegExp(`'${plan}'`));
  assert.match(sql, /price_status/); assert.match(sql, /PLACEHOLDER/);
  assert.doesNotMatch(sql, /external\.submission|submission\.external/);
  assert.match(routes, /external_submission_disabled/);
  assert.match(routes, /reply\.code\(423\)/);
});

test("registration accepts only active, approved, explicitly priced plans", async () => {
  const platform = await readFile(new URL("../platform/saas-platform.mjs", import.meta.url), "utf8");
  assert.match(platform, /code=\$1 AND active AND price_status='APPROVED' AND recommended_monthly_price_minor IS NOT NULL/);
  assert.match(platform, /plan_not_available/);
  assert.match(platform, /\$1::uuid::text/);
});

test("approved registration creates only pending, verification-bound records", async () => {
  const calls = [];
  const client = { async query(sql, params = []) {
    calls.push([String(sql), params]);
    if (String(sql).startsWith("SELECT 1 FROM saas.plans")) return { rowCount: 1, rows: [{ ok: 1 }] };
    return { rowCount: 1, rows: [] };
  } };
  const created = await registerPendingTenant(client, { email: "owner@example.invalid", company: "Isolated GmbH", plan: "CORE" }, { verificationPepper: "isolated-verification-pepper-over-thirty-two-characters" });
  assert.equal(created.plan, "CORE");
  assert.ok(created.token.length >= 32);
  assert.deepEqual(calls.map(([sql]) => sql === "BEGIN" || sql === "COMMIT" ? sql : sql.split(/\s+/).slice(0, 3).join(" ")), ["BEGIN", "SELECT 1 FROM", "SELECT set_config('app.tenant_id',$1,true)", "INSERT INTO saas.tenants(id,slug,display_name,customer_identity_hash,company_identity_hash)", "INSERT INTO saas.pending_registrations(tenant_id,email,requested_plan_code,verification_token_hash,verification_expires_at,request_ip_hash,request_user_agent_hash)", "INSERT INTO saas.subscriptions(tenant_id,plan_code,status)", "SELECT tenant_portal.provision_empty_tenant($1,$2)", "INSERT INTO saas.audit_events(tenant_id,action,target_type,target_id,metadata)", "COMMIT"]);

  const unavailable = { async query(sql) { if (sql === "BEGIN" || sql === "ROLLBACK") return { rowCount: 0, rows: [] }; return { rowCount: 0, rows: [] }; } };
  await assert.rejects(registerPendingTenant(unavailable, { email: "owner@example.invalid", company: "Isolated GmbH", plan: "CORE" }, { verificationPepper: "isolated-verification-pepper-over-thirty-two-characters" }), /plan_not_available/);
});

test("server keeps SaaS behind a default-off feature flag and isolates company scopes", async () => {
  const server = await readFile(new URL("../platform/server.mjs", import.meta.url), "utf8");
  assert.match(server, /WB_TENDER_SAAS_ENABLED === "true"/);
  assert.match(server, /saasEnabled = saasRequested && stripeProviderConfigured/);
  assert.match(server, /identity\.companyIds = identity\.saas\.companyIds/);
  assert.match(server, /Object\.hasOwn\(SAAS_PERMISSION_FEATURES, permission\)/);
  assert.match(server, /saas_legacy_data_plane_forbidden/);
  assert.match(server, /inline_secret_forbidden_/);
  for (const name of ["HOST", "PORT", "SECURE", "USER", "PASSWORD", "FROM"]) assert.match(server, new RegExp(`fileOnlySecret\\(\\"SAAS_SMTP_${name}\\"\\)`));
  assert.match(server, /const sectors = enabled \? new DatabaseSync/);
});
