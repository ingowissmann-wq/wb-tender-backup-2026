import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import Fastify from "fastify";
import rawBody from "fastify-raw-body";
import { StripeBillingAdapter, UnconfiguredBillingAdapter } from "../platform/saas-adapters.mjs";
import { registerBillingWebhookRoute } from "../platform/saas-platform.mjs";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = 1_800_000_000_000;
const WEBHOOK_SECRET = "whsec_test_test_test_test_test_test";

const signatureFor = (body, timestamp = Math.floor(NOW / 1000)) => {
  const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.`).update(body).digest("hex");
  return `t=${timestamp},v1=${signature}`;
};

const stripeAdapter = () => new StripeBillingAdapter({
  secretKey: "sk_test_placeholder",
  webhookSecret: WEBHOOK_SECRET,
  publicBaseUrl: "https://suite.example.invalid",
  now: () => NOW,
});

async function webhookApp({ adapter = stripeAdapter(), enabled = true, withRawBody = true, applyEvent } = {}) {
  const app = Fastify({ logger: false });
  if (withRawBody) await app.register(rawBody, { field: "rawBody", global: false, encoding: false, runFirst: true });
  const client = { release() {} };
  const pool = { connect: async () => client };
  registerBillingWebhookRoute(app, { pool, enabled, billingAdapter: adapter, applyEvent });
  await app.ready();
  return app;
}

const checkoutEvent = (overrides = {}) => ({
  id: "evt_checkout_paid",
  type: "checkout.session.completed",
  data: { object: {
    id: "cs_test_paid",
    mode: "subscription",
    payment_status: "paid",
    client_reference_id: TENANT_ID,
    customer: "cus_test",
    subscription: "sub_test",
    ...overrides,
  } },
});

test("Stripe webhook verifies the exact raw body and reports duplicate processing idempotently", async (t) => {
  const processed = new Set();
  let observedRaw;
  const app = await webhookApp({ applyEvent: async (_client, event, raw) => {
    observedRaw = raw;
    if (processed.has(event.id)) return { idempotent: true };
    processed.add(event.id);
    return { idempotent: false };
  } });
  t.after(() => app.close());
  const body = Buffer.from(`{\n  "id": "evt_checkout_paid", "type": "checkout.session.completed",\n  "data": {"object":{"id":"cs_test_paid","mode":"subscription","payment_status":"paid","client_reference_id":"${TENANT_ID}","customer":"cus_test","subscription":"sub_test"}}\n}`);
  const headers = { "content-type": "application/json", "stripe-signature": signatureFor(body) };

  const first = await app.inject({ method: "POST", url: "/api/saas/billing/webhook", headers, payload: body });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), { received: true, idempotent: false });
  assert.deepEqual(observedRaw, body);

  const duplicate = await app.inject({ method: "POST", url: "/api/saas/billing/webhook", headers, payload: body });
  assert.equal(duplicate.statusCode, 200);
  assert.deepEqual(duplicate.json(), { received: true, idempotent: true });
  assert.equal(processed.size, 1);
});

test("Stripe webhook fails closed when the raw-body plugin is absent", async (t) => {
  let processed = false;
  const app = await webhookApp({ withRawBody: false, applyEvent: async () => { processed = true; } });
  t.after(() => app.close());
  const body = Buffer.from(JSON.stringify(checkoutEvent()));
  const response = await app.inject({ method: "POST", url: "/api/saas/billing/webhook", headers: { "content-type": "application/json", "stripe-signature": signatureFor(body) }, payload: body });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "billing_webhook_raw_body_required");
  assert.equal(processed, false);
});

test("Stripe webhook rejects invalid signatures before acquiring a database client", async (t) => {
  const app = Fastify({ logger: false });
  await app.register(rawBody, { field: "rawBody", global: false, encoding: false, runFirst: true });
  let connected = false;
  registerBillingWebhookRoute(app, {
    pool: { connect: async () => { connected = true; throw new Error("must_not_connect"); } },
    enabled: true,
    billingAdapter: stripeAdapter(),
  });
  await app.ready();
  t.after(() => app.close());
  const body = Buffer.from(JSON.stringify(checkoutEvent()));
  const response = await app.inject({ method: "POST", url: "/api/saas/billing/webhook", headers: { "content-type": "application/json", "stripe-signature": `t=${Math.floor(NOW / 1000)},v1=${"00".repeat(32)}` }, payload: body });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "billing_webhook_signature_invalid");
  assert.equal(connected, false);
});

test("signed irrelevant Stripe events are acknowledged and filtered without database writes", async (t) => {
  let applied = false;
  const app = await webhookApp({ applyEvent: async () => { applied = true; } });
  t.after(() => app.close());
  const body = Buffer.from(JSON.stringify({ id: "evt_irrelevant", type: "customer.created", data: { object: { id: "cus_other" } } }));
  const response = await app.inject({ method: "POST", url: "/api/saas/billing/webhook", headers: { "content-type": "application/json", "stripe-signature": signatureFor(body) }, payload: body });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { received: true, ignored: true });
  assert.equal(applied, false);
});

test("Stripe adapter supports paid and failed invoices with old and current subscription metadata shapes", () => {
  const adapter = stripeAdapter();
  const paid = Buffer.from(JSON.stringify({ id: "evt_invoice_paid", type: "invoice.paid", data: { object: {
    id: "in_paid", status: "paid", paid: true, customer: "cus_test", billing_reason: "subscription_cycle",
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_test", metadata: { tenant_id: TENANT_ID } } },
  } } }));
  const paidEvent = adapter.verifyWebhook(paid, signatureFor(paid));
  assert.equal(paidEvent.type, "invoice.paid");
  assert.equal(paidEvent.subscriptionRef, "sub_test");
  assert.equal(paidEvent.billingReason, "subscription_cycle");

  const failed = Buffer.from(JSON.stringify({ id: "evt_invoice_failed", type: "invoice.payment_failed", data: { object: {
    id: "in_failed", paid: false, customer: "cus_test", subscription: "sub_test", subscription_details: { metadata: { tenant_id: TENANT_ID } },
  } } }));
  assert.equal(adapter.verifyWebhook(failed, signatureFor(failed)).type, "payment.failed");
});

test("unpaid checkout and inconsistent invoice.paid events never reach billing state processing", async (t) => {
  let applied = 0;
  const app = await webhookApp({ applyEvent: async () => { applied += 1; } });
  t.after(() => app.close());
  for (const event of [
    checkoutEvent({ payment_status: "unpaid" }),
    { id: "evt_false_paid", type: "invoice.paid", data: { object: { id: "in_false", status: "open", paid: false, metadata: { tenant_id: TENANT_ID } } } },
  ]) {
    const body = Buffer.from(JSON.stringify(event));
    const response = await app.inject({ method: "POST", url: "/api/saas/billing/webhook", headers: { "content-type": "application/json", "stripe-signature": signatureFor(body) }, payload: body });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "billing_event_unsupported_or_unpaid");
  }
  assert.equal(applied, 0);
});

test("webhook stays unavailable when SaaS or Stripe configuration is disabled", async (t) => {
  const disabled = await webhookApp({ enabled: false, adapter: new UnconfiguredBillingAdapter() });
  const unconfigured = await webhookApp({ enabled: true, adapter: new UnconfiguredBillingAdapter() });
  t.after(async () => { await disabled.close(); await unconfigured.close(); });
  const request = { method: "POST", url: "/api/saas/billing/webhook", headers: { "content-type": "application/json" }, payload: "{}" };
  assert.equal((await disabled.inject(request)).statusCode, 404);
  assert.equal((await unconfigured.inject(request)).statusCode, 503);
});

test("checkout preparation uses the selected price against an isolated mock only", async (t) => {
  let observed;
  const provider = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    observed = { method: req.method, authorization: req.headers.authorization, idempotency: req.headers["idempotency-key"], body: new URLSearchParams(body) };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "cs_test_internal_only", url: "https://checkout.example.invalid/session" }));
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  t.after(() => provider.close());
  const adapter = new StripeBillingAdapter({ secretKey: "sk_test_isolated_only", webhookSecret: WEBHOOK_SECRET, publicBaseUrl: "https://saas.example.invalid", priceIds: { CORE: "price_isolatedCore" }, apiBase: `http://127.0.0.1:${provider.address().port}` });
  const checkout = await adapter.createCheckout({ tenantId: TENANT_ID, plan: "CORE" });
  assert.equal(checkout.id, "cs_test_internal_only");
  assert.equal(observed.method, "POST");
  assert.equal(observed.authorization, "Bearer sk_test_isolated_only");
  assert.equal(observed.idempotency, `wb-trial-${TENANT_ID}`);
  assert.equal(observed.body.get("line_items[0][price]"), "price_isolatedCore");
  assert.equal(observed.body.get("client_reference_id"), TENANT_ID);
});
