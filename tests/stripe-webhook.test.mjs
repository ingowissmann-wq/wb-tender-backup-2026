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
  if (adapter instanceof StripeBillingAdapter) adapter.resolvePaymentPeriod = async event => event;
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
    currency: "eur", amount_subtotal: 349000,
    metadata: { plan_code: "NORMAL", billing_path: "AUTO_CARD", purchase_kind: "PACKAGE", booking_id: TENANT_ID, consent_version: "standalone-2026-09-07", renewal: "false" },
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
  const body = Buffer.from(JSON.stringify(checkoutEvent(), null, 2));
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

test("standalone trial charges only 299 for all methods and never creates future charges", async (t) => {
  const observed = [];
  const provider = http.createServer(async (req,res)=>{
    let body=''; for await(const chunk of req)body+=chunk;
    if(req.url==='/v1/customers'){const data=new URLSearchParams(body);res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'cus_booking',metadata:{tenant_id:data.get('metadata[tenant_id]'),booking_id:data.get('metadata[booking_id]')}}));return;}
    observed.push({path:req.url,body:new URLSearchParams(body),idempotency:req.headers['idempotency-key']});
    res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'cs_trial',url:'https://checkout.example.invalid/trial'}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');t.after(()=>provider.close());
  const adapter = new StripeBillingAdapter({secretKey:'sk_test_isolated',webhookSecret:WEBHOOK_SECRET,publicBaseUrl:'https://www.enwi.online',activationPriceId:'price_activation299',apiBase:`http://127.0.0.1:${provider.address().port}`});
  for(const [billingPath,method] of [['AUTO_CARD','card'],['INVOICE_BANK_TRANSFER','customer_balance'],['INVOICE_BILLIE','billie']]){
    await adapter.createCheckout({tenantId:TENANT_ID,plan:'TRIAL',purchaseKind:'TRIAL',billingPath,bookingId:billingPath,consentVersion:'standalone-2026-09-07'});
    const session=observed.at(-1).body;
    assert.equal(session.get('mode'),'payment');assert.equal(session.get('line_items[0][price]'),'price_activation299');
    assert.equal(session.get('line_items[1][price]'),null);assert.equal(session.get('payment_method_types[0]'),method);
    assert.equal(session.get('metadata[purchase_kind]'),'TRIAL');assert.equal(session.get('metadata[plan_code]'),'TRIAL');
    assert.equal(session.get('success_url'),'https://www.enwi.online/saas/trial-complete?session_id={CHECKOUT_SESSION_ID}');
    assert.equal(session.get('payment_method_collection'),null);
    if(method==='customer_balance'){assert.equal(session.get('customer'),'cus_booking');assert.equal(session.get('payment_method_options[customer_balance][funding_type]'),'bank_transfer');assert.equal(session.get('payment_method_options[customer_balance][bank_transfer][type]'),'eu_bank_transfer');assert.equal(session.get('payment_method_options[customer_balance][bank_transfer][eu_bank_transfer][country]'),'DE');}
    assert.ok(![...session.keys()].some(k=>/subscription_data|setup_future_usage/.test(k)));
    assert.ok(!session.toString().includes('sepa'));
    assert.deepEqual(await adapter.prepareCheckoutCompletion({type:'payment.confirmed'}),{prepared:false});
  }
  assert.equal(observed.length,3);assert.ok(observed.every(r=>r.path==='/v1/checkout/sessions'));
});

test("all three packages use separate card subscriptions or explicitly paid manual months", async(t)=>{
  const observed=[];
  const prices={NORMAL:99000,PROFESSIONAL:149000,ENTERPRISE:249000};
  const provider=http.createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.method==='GET'){const plan=req.url.split('_').at(-1);res.end(JSON.stringify({active:true,currency:'eur',unit_amount:prices[plan],product:'prod_'+plan,tax_behavior:'exclusive',recurring:{interval:'month',interval_count:1}}));return;}
    let body='';for await(const c of req)body+=c;if(req.url==='/v1/customers'){const data=new URLSearchParams(body);res.end(JSON.stringify({id:'cus_booking',metadata:{tenant_id:data.get('metadata[tenant_id]'),booking_id:data.get('metadata[booking_id]')}}));return;}observed.push(new URLSearchParams(body));res.end(JSON.stringify({id:'cs_package',url:'https://checkout.example.invalid/package'}));
  });provider.listen(0,'127.0.0.1');await once(provider,'listening');t.after(()=>provider.close());
  const adapter=new StripeBillingAdapter({secretKey:'sk_test_isolated',webhookSecret:WEBHOOK_SECRET,publicBaseUrl:'https://www.enwi.online',priceIds:Object.fromEntries(Object.keys(prices).map(p=>[p,'price_'+p])),setupPriceIds:Object.fromEntries(Object.keys(prices).map(p=>[p,'price_setup'+p])),apiBase:`http://127.0.0.1:${provider.address().port}`});
  for(const plan of Object.keys(prices))for(const billingPath of ['AUTO_CARD','INVOICE_BANK_TRANSFER','INVOICE_BILLIE']){
    const input={tenantId:TENANT_ID,plan,purchaseKind:'PACKAGE',billingPath,bookingId:plan+billingPath,consentVersion:'standalone-2026-09-07'};
    await adapter.createCheckout(input);const session=observed.at(-1);
    assert.equal(session.get('mode'),billingPath==='AUTO_CARD'?'subscription':'payment');
    assert.equal(session.get('line_items[1][price]'),'price_setup'+plan);
    assert.equal(session.get('metadata[purchase_kind]'),'PACKAGE');
    assert.equal(session.get('subscription_data[trial_period_days]'),null);
    assert.equal(session.get('subscription_data[automatic_tax][enabled]'),null);
    assert.equal(session.get('automatic_tax[enabled]'),'true');
    assert.ok(!session.toString().includes('activation'));assert.ok(!session.toString().includes('sepa'));
    if(billingPath!=='AUTO_CARD'){
      assert.equal(session.get('line_items[0][price_data][unit_amount]'),String(prices[plan]));
      await adapter.createCheckout({...input,bookingId:input.bookingId+'renew',renewal:true});
      assert.equal(observed.at(-1).get('line_items[1][price]'),null);
    }
  }
});

test("signed trial/package confusion and legacy metadata are rejected",()=>{
  const adapter=stripeAdapter();
  const metadata={purchase_kind:'TRIAL',plan_code:'TRIAL',billing_path:'AUTO_CARD',booking_id:TENANT_ID,consent_version:'standalone-2026-09-07',renewal:'false'};
  for(const overrides of [
    {metadata},
    {mode:'payment',subscription:null,metadata:{...metadata,plan_code:'NORMAL'}},
    {mode:'payment',subscription:null,metadata:{...metadata,purchase_kind:'PACKAGE'}},
    {metadata:{plan_code:'NORMAL'}},
  ]){const raw=Buffer.from(JSON.stringify(checkoutEvent(overrides)));assert.throws(()=>adapter.verifyWebhook(raw,signatureFor(raw)),/billing_/);}
  const event=checkoutEvent({mode:'payment',subscription:null,amount_subtotal:29900,metadata});
  for(const type of ['checkout.session.completed','checkout.session.async_payment_succeeded']){
    event.type=type;const raw=Buffer.from(JSON.stringify(event));assert.equal(adapter.verifyWebhook(raw,signatureFor(raw)).purchaseKind,'TRIAL');
  }
});

test('live Klarna is blocked for the B2B product before contacting Stripe',async()=>{
  const adapter=new StripeBillingAdapter({secretKey:'sk_live_synthetic_not_a_real_key',webhookSecret:WEBHOOK_SECRET,publicBaseUrl:'https://www.enwi.online'});
  await assert.rejects(adapter.createCheckout({purchaseKind:'TRIAL',plan:'TRIAL',billingPath:'INVOICE_KLARNA',bookingId:TENANT_ID,consentVersion:'standalone-2026-09-07'}),/stripe_billing_path_invalid/);
});

test('card package access uses the verified Stripe period and rejects another tenant subscription',async(t)=>{
  let wrongTenant=false;
  const periodEnd=Math.floor(NOW/1000)+86400*30;
  const provider=http.createServer((req,res)=>{
    res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'sub_test',customer:'cus_test',status:'active',metadata:{tenant_id:wrongTenant?'another-tenant':TENANT_ID,purchase_kind:'PACKAGE',plan_code:'NORMAL'},items:{data:[{price:{id:'price_pro'},current_period_end:periodEnd}]}}));
  });provider.listen(0,'127.0.0.1');await once(provider,'listening');t.after(()=>provider.close());
  const adapter=new StripeBillingAdapter({secretKey:'sk_test_isolated',webhookSecret:WEBHOOK_SECRET,publicBaseUrl:'https://www.enwi.online',priceIds:{NORMAL:'price_pro'},now:()=>NOW,apiBase:`http://127.0.0.1:${provider.address().port}`});
  const event={type:'payment.confirmed',purchaseKind:'PACKAGE',billingPath:'AUTO_CARD',subscriptionRef:'sub_test',customerRef:'cus_test',tenantId:TENANT_ID,plan:'NORMAL'};
  assert.equal((await adapter.resolvePaymentPeriod(event)).periodEnd,periodEnd);
  wrongTenant=true;await assert.rejects(adapter.resolvePaymentPeriod(event),/billing_subscription_period_invalid/);
  const trial={...event,purchaseKind:'TRIAL'};assert.deepEqual(await adapter.resolvePaymentPeriod(trial),trial);
});

test('bank transfer activates only a signed paid asynchronous event with explicit booking metadata', async t => {
  let activations=0;
  const app=await webhookApp({applyEvent:async()=>{activations++;return {idempotent:false};}});
  t.after(()=>app.close());
  const event=checkoutEvent({mode:'payment',subscription:null,amount_subtotal:29900,
    metadata:{tenant_id:TENANT_ID,purchase_kind:'TRIAL',plan_code:'TRIAL',billing_path:'INVOICE_BANK_TRANSFER',booking_id:TENANT_ID,consent_version:'standalone-2026-09-07',renewal:'false'}});
  event.type='checkout.session.async_payment_succeeded';
  for(const paid of ['unpaid','no_payment_required']){
    event.data.object.payment_status=paid;const body=Buffer.from(JSON.stringify(event));
    const result=await app.inject({method:'POST',url:'/api/saas/billing/webhook',headers:{'content-type':'application/json','stripe-signature':signatureFor(body)},payload:body});
    assert.equal(result.statusCode,400);assert.equal(activations,0);
  }
  event.data.object.payment_status='paid';const body=Buffer.from(JSON.stringify(event));
  assert.equal((await app.inject({method:'POST',url:'/api/saas/billing/webhook',headers:{'content-type':'application/json','stripe-signature':signatureFor(body)},payload:body})).statusCode,200);
  assert.equal(activations,1);
});

test('bank checkout rejects a customer returned for another tenant before creating a session',async t=>{
  const paths=[];
  const provider=http.createServer(async(req,res)=>{paths.push(req.url);for await(const chunk of req){}res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'cus_wrong',metadata:{tenant_id:'other-tenant',booking_id:TENANT_ID}}));});
  provider.listen(0,'127.0.0.1');await once(provider,'listening');t.after(()=>provider.close());
  const adapter=new StripeBillingAdapter({secretKey:'sk_test_synthetic',webhookSecret:WEBHOOK_SECRET,publicBaseUrl:'https://www.enwi.online',activationPriceId:'price_trial',apiBase:`http://127.0.0.1:${provider.address().port}`});
  await assert.rejects(adapter.createCheckout({tenantId:TENANT_ID,bookingId:TENANT_ID,purchaseKind:'TRIAL',plan:'TRIAL',billingPath:'INVOICE_BANK_TRANSFER',consentVersion:'standalone-2026-09-07'}),/stripe_bank_customer_binding_invalid/);
  assert.deepEqual(paths,['/v1/customers']);
});
