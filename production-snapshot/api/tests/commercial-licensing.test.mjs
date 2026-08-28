import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  INITIAL_COMMERCIAL_PRODUCTS, applyCommercialBillingEvent, assessLicenseRemoval, explainCommercialEntitlements,
  licenseAllowsAccess, resolveCommercialEntitlements, resolveStripePriceOffer, selectCommercialOffer,
  validatePriceProductMatch,
} from "../platform/commercial-licensing.mjs";

const NOW = new Date("2026-08-19T12:00:00Z");
const catalog = Object.fromEntries(INITIAL_COMMERCIAL_PRODUCTS.map((item) => [item.key, item]));
const license = (id, product, status = "ACTIVE", extra = {}) => ({ id, product_key: product, status, ...extra });
const rows = (licenseId, productKey) => catalog[productKey].modules.map((module_key) => ({ license_id: licenseId, module_key, exposure: "EXPOSED" }));
const resolve = (licenses, productModules, explicitModules = []) => resolveCommercialEntitlements({ licenses, productModules, explicitModules, now: NOW });

test("initial catalog separates eleven sellable products from canonical technical modules", () => {
  assert.deepEqual(Object.keys(catalog), ["wb_tender_scout","wb_tender_autopilot","wb_tender_professional","wb_tender_enterprise","wb_crm","wb_csm","wb_flow","wb_people","wb_docs","wb_insights","wb_business_suite"]);
  assert.deepEqual(catalog.wb_tender_scout.modules, ["tender_scout", "control"]);
  assert.deepEqual(catalog.wb_crm.modules, ["crm", "control"]);
  assert.equal(catalog.wb_business_suite.modules.length, 10);
  assert.equal(new Set(catalog.wb_business_suite.modules).size, 10);
});

test("standalone Autopilot grants hidden capabilities but no Scout or Docs navigation", () => {
  const active = license("autopilot", "wb_tender_autopilot");
  const result = resolve([active], [
    ...rows(active.id, active.product_key),
    { license_id: active.id, module_key: "tender_autopilot", exposure: "CAPABILITY_ONLY", capability_key: "tender.public_discovery" },
    { license_id: active.id, module_key: "tender_autopilot", exposure: "CAPABILITY_ONLY", capability_key: "docs.object_storage" },
  ]);
  assert.deepEqual(result.modules, ["tender_autopilot", "control"]);
  assert.equal(result.modules.includes("tender_scout"), false);
  assert.equal(result.modules.includes("docs"), false);
  assert.deepEqual(result.capabilities, ["tender.public_discovery", "docs.object_storage"]);
});

test("standalone Tender Scout exposes only Scout and baseline Control", () => {
  const scout = license("scout-only", "wb_tender_scout");
  assert.deepEqual(resolve([scout], rows(scout.id, scout.product_key)).modules, ["tender_scout", "control"]);
});

test("Tender Professional, CRM-only and full suite resolve from product definitions", () => {
  for (const [key, expected] of [
    ["wb_tender_professional", ["tender_scout","tender_autopilot","docs","flow","insights","control"]],
    ["wb_crm", ["crm","control"]],
    ["wb_business_suite", ["tender_scout","tender_autopilot","crm","csm","flow","people","docs","control","insights","connect"]],
  ]) {
    const current = license(key, key);
    assert.deepEqual(resolve([current], rows(current.id, key)).modules, expected);
  }
});

test("multiple products union without duplicates and one cancellation preserves overlap", () => {
  const scout = license("scout", "wb_tender_scout"), docs = license("docs", "wb_docs"), crm = license("crm", "wb_crm");
  const productRows = [...rows(scout.id, scout.product_key), ...rows(docs.id, docs.product_key), ...rows(crm.id, crm.product_key)];
  assert.deepEqual(resolve([scout, docs, crm], productRows).modules, ["tender_scout","control","docs","crm"]);
  scout.status = "CANCELED";
  assert.deepEqual(resolve([scout, docs, crm], productRows).modules, ["docs","control","crm"]);
});

test("entitlement explanations identify overlap and explicit revoke precedence", () => {
  const scout = license("scout-explain", "wb_tender_scout");
  const professional = license("professional-explain", "wb_tender_professional");
  const explicit = [{ module_key: "tender_scout", enabled: false, source: "DIRECT", action: "REVOKE", reason: "contract exception" }];
  const explanation = explainCommercialEntitlements({ licenses: [scout, professional],
    productModules: [...rows(scout.id, scout.product_key), ...rows(professional.id, professional.product_key)], explicitModules: explicit, now: NOW });
  const tenderScout = explanation.find((item) => item.moduleKey === "tender_scout");
  assert.equal(tenderScout.entitled, false);
  assert.equal(tenderScout.overlappingLicense, true);
  assert.deepEqual(tenderScout.inheritedProducts, ["wb_tender_professional", "wb_tender_scout"]);
  assert.equal(tenderScout.explanation, "explicit_revoke_overrides_products");
  assert.equal(tenderScout.explicitOverride.reason, "contract exception");
});

test("downgrade impact retains overlap and never claims module data deletion", () => {
  const professional = license("professional-remove", "wb_tender_professional");
  const docs = license("docs-retain", "wb_docs");
  const impact = assessLicenseRemoval({ licenseId: professional.id, licenses: [professional, docs],
    productModules: [...rows(professional.id, professional.product_key), ...rows(docs.id, docs.product_key)], now: NOW });
  assert.equal(impact.lostModules.includes("tender_autopilot"), true);
  assert.equal(impact.lostModules.includes("docs"), false);
  assert.equal(impact.retainedModules.includes("docs"), true);
  assert.equal(impact.dataRetained, true);
  assert.equal(impact.dataDeleted, false);
});

test("explicit revocation wins over all inherited grants and an explicit grant adds a module", () => {
  const suite = license("suite", "wb_business_suite");
  const result = resolve([suite], rows(suite.id, suite.product_key), [
    { module_key: "docs", enabled: false, starts_at: "2026-08-01" },
    { module_key: "connect", enabled: false, starts_at: "2026-08-01" },
    { module_key: "crm", enabled: true, starts_at: "2026-08-01" },
  ]);
  assert.equal(result.modules.includes("docs"), false);
  assert.equal(result.modules.includes("connect"), false);
  assert.equal(new Set(result.modules).size, result.modules.length);
});

test("past-due, canceled, suspended and expired licenses revoke access immediately", () => {
  for (const status of ["PAST_DUE", "CANCELED", "SUSPENDED", "EXPIRED"]) assert.equal(licenseAllowsAccess(license(status, "wb_crm", status), NOW), false);
  assert.equal(licenseAllowsAccess(license("expired-period", "wb_crm", "ACTIVE", { current_period_ends_at: "2026-08-19T11:59:59Z" }), NOW), false);
  assert.equal(licenseAllowsAccess(license("expired-trial", "wb_crm", "TRIAL_ACTIVE", { trial_ends_at: "2026-08-19T11:59:59Z" }), NOW), false);
});

test("Stripe offer resolution accepts one active mapping and fails closed for unknown, retired or ambiguous prices", () => {
  const active = { provider: "stripe", stripe_price_id: "price_test", commercial_product_key: "wb_crm", status: "ACTIVE" };
  const retired = { ...active, status: "RETIRED" };
  assert.equal(resolveStripePriceOffer([retired, active], "price_test"), active);
  assert.throws(() => resolveStripePriceOffer([retired], "price_test"), /unknown_or_inactive/);
  assert.throws(() => resolveStripePriceOffer([], "price_unknown"), /unknown_or_inactive/);
  assert.throws(() => resolveStripePriceOffer([active, { ...active }], "price_test"), /ambiguous/);
  assert.throws(() => validatePriceProductMatch(active, "wb_docs"), /metadata_mismatch/);
  assert.equal(validatePriceProductMatch(active, "wb_crm"), active);
});

test("product checkout requires an exact Price when multiple active offers exist", () => {
  const offers = [
    { status: "ACTIVE", commercial_product_key: "wb_crm", stripe_price_id: "price_crm_month" },
    { status: "ACTIVE", commercial_product_key: "wb_crm", stripe_price_id: "price_crm_year" },
  ];
  assert.throws(() => selectCommercialOffer(offers, { productKey: "wb_crm" }), /commercial_offer_selection_required/);
  assert.equal(selectCommercialOffer(offers, { productKey: "wb_crm", priceId: "price_crm_year" }).stripe_price_id, "price_crm_year");
  assert.throws(() => selectCommercialOffer(offers, { productKey: "wb_docs", priceId: "price_crm_year" }), /commercial_offer_not_available/);
});

const billingClient = ({ duplicate = false, product = "wb_crm", requestedProductKey = null } = {}) => {
  const calls = [];
  const offerId = "30000000-0000-4000-8000-000000000001";
  const current = { id: "40000000-0000-4000-8000-000000000001", offer_id: offerId, provider_customer_ref: "cus_one", status: "ACTIVE" };
  return { calls, current, async query(sql, params = []) {
    const text = String(sql); calls.push([text, params]);
    if (text.includes("INSERT INTO saas.billing_events")) return { rowCount: duplicate ? 0 : 1, rows: duplicate ? [] : [{ provider_event_id: params[1] }] };
    if (text.includes("FROM saas.stripe_price_offers")) return { rowCount: 1, rows: [{ offer_id: offerId, stripe_price_id: params[0], commercial_product_key: product, status: "ACTIVE", product_active: true, past_due_access: false, offer_class: "REGULAR" }] };
    if (text.startsWith("SELECT * FROM saas.tenant_product_licenses")) return { rowCount: 1, rows: [{ ...current }] };
    if (text.startsWith("UPDATE saas.tenant_product_licenses")) return { rowCount: 1, rows: [{ ...current, status: params[1] }] };
    return { rowCount: 1, rows: [] };
  }, requestedProductKey };
};

test("invoice paid renews while payment failure and cancellation change only the provider-bound license", async () => {
  for (const [type, expected] of [["invoice.paid", "ACTIVE"], ["payment.failed", "PAST_DUE"], ["subscription.canceled", "CANCELED"]]) {
    const client = billingClient();
    const result = await applyCommercialBillingEvent(client, { id: `evt_${type}`, type, tenantId: "10000000-0000-4000-8000-000000000001", provider: "stripe", priceId: "price_crm", customerRef: "cus_one", subscriptionRef: "sub_crm" }, Buffer.from(type), NOW);
    assert.equal(result.status, expected);
    const update = client.calls.find(([sql]) => sql.startsWith("UPDATE saas.tenant_product_licenses"));
    assert.equal(update[1][0], client.current.id);
    assert.equal(update[1][1], expected);
    assert.equal(client.calls.some(([sql]) => /UPDATE saas\.tenant_product_licenses/.test(sql) && /tenant_id=\$1/.test(sql)), false);
  }
});

test("billing event duplicates are idempotent and price metadata mismatch is audited then rejected", async () => {
  const duplicate = billingClient({ duplicate: true });
  assert.deepEqual(await applyCommercialBillingEvent(duplicate, { id: "evt_duplicate", type: "invoice.paid", tenantId: "10000000-0000-4000-8000-000000000001", provider: "stripe", priceId: "price_crm" }, Buffer.from("duplicate"), NOW), { idempotent: true });
  assert.equal(duplicate.calls.some(([sql]) => sql.includes("stripe_price_offers")), false);

  const mismatch = billingClient({ product: "wb_crm" });
  await assert.rejects(applyCommercialBillingEvent(mismatch, { id: "evt_mismatch", type: "invoice.paid", tenantId: "10000000-0000-4000-8000-000000000001", provider: "stripe", priceId: "price_crm", requestedProductKey: "wb_docs", customerRef: "cus_one", subscriptionRef: "sub_crm" }, Buffer.from("mismatch"), NOW), /metadata_mismatch/);
  assert.equal(mismatch.calls.some(([sql]) => sql.includes("PRICE_PRODUCT_MISMATCH")), true);
  assert.equal(mismatch.calls.at(-1)[0], "COMMIT");
});

test("migration enforces tenant RLS, idempotency, active-price uniqueness, audit and legacy backfill", async () => {
  const sql = await readFile(new URL("../migrations/100_commercial_product_licensing.sql", import.meta.url), "utf8");
  for (const table of ["tenant_product_licenses", "license_events"]) {
    assert.match(sql, new RegExp(`${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`${table} FORCE ROW LEVEL SECURITY`));
  }
  assert.match(sql, /stripe_price_one_active_offer/);
  assert.match(sql, /saas\.tenant_matches\(candidate\)/);
  assert.match(sql, /t\.status='ACTIVE'/);
  assert.match(sql, /NOT EXISTS\(SELECT 1 FROM saas\.tenant_product_licenses/);
  assert.match(sql, /wb_legacy_'\|\|lower\(item\.plan_code\)/);
  assert.match(sql, /coalesce\(e\.enabled,i\.module_key IS NOT NULL,false\)/);
  assert.match(sql, /PRICE_PRODUCT_MISMATCH|commercial_product_capabilities/);
});

test("Green package hardening keeps the paid trial contract and makes it the full ten-module suite", async () => {
  const sql = await readFile(new URL("../migrations/105_green_commercial_packages.sql", import.meta.url), "utf8");
  const rollback = await readFile(new URL("../deployment/rollback-green-commercial-packages.sql", import.meta.url), "utf8");
  const offers = JSON.parse(await readFile(new URL("../config/green-commercial-stripe-offers.json", import.meta.url), "utf8"));
  assert.match(sql, /wb_business_suite_trial_14d/);
  assert.match(sql, /module_count<>10/);
  assert.match(sql, /data_retained_on_expiry/);
  assert.doesNotMatch(sql, /price_[A-Za-z0-9_]+/);
  assert.match(rollback, /rollback_refused_manual_module_history_exists/);
  assert.equal(offers.regularOffers.length, 11);
  assert.equal(offers.regularOffers.every((offer) => offer.stripePriceId === null && offer.verificationStatus === "MISSING"), true);
  assert.deepEqual(offers.existingContractOffer, { productKey: "wb_business_suite_trial_14d",
    stripePriceId: "price_1U5VsIE0SiqbbyKf1wdyWTUR", verificationStatus: "REPOSITORY_CONTRACT_ONLY", currency: "EUR", amountMinor: 19900,
    billingType: "ONE_TIME", elapsedDays: 14 });
});

test("admin contract is internal, reason-audited, tenant-bound and never exposes Stripe secrets", async () => {
  const source = await readFile(new URL("../platform/saas-platform.mjs", import.meta.url), "utf8");
  assert.match(source, /admin\/tenants\/:id\/licenses/);
  assert.match(source, /MANUAL_GRANTED/);
  assert.match(source, /ADMIN_\$\{action\}/);
  assert.match(source, /MODULE_MANUAL_\$\{action\}/);
  assert.match(source, /downgrade-impact/);
  assert.match(source, /dataRetentionPolicy: "RETAIN_ON_DOWNGRADE"/);
  assert.match(source, /withTenantContext/);
  assert.doesNotMatch(source, /stripeSecretKey|STRIPE_SECRET_KEY/);
});

test("commercial licensing changes do not weaken submission safety", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile.release", import.meta.url), "utf8");
  const routes = await readFile(new URL("../platform/autopilot-routes.mjs", import.meta.url), "utf8");
  assert.match(dockerfile, /EXTERNAL_SUBMISSION_ENABLED=false/);
  assert.match(dockerfile, /WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false/);
  assert.match(routes, /external_submission_disabled/);
  assert.match(routes, /reply\.code\(423\)/);
});
