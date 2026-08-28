import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_TRIAL_REMINDER_OFFSETS, PAID_TRIAL_PRODUCT_KEY, classifyTrialDeliveryFailure,
  normalizeReminderOffsets, paidTrialEnd, trialBillingStatus, trialDaysRemaining, trialReminderMessage,
} from "../platform/trial-lifecycle.mjs";
import { licenseAllowsAccess } from "../platform/commercial-licensing.mjs";
import { normalizedCompanyIdentity } from "../platform/saas-adapters.mjs";

const START = new Date("2026-08-19T12:34:56.789Z");
const END = new Date("2026-09-02T12:34:56.789Z");

test("paid trial is exactly 14 elapsed days and access fails closed at the exact boundary", () => {
  assert.equal(paidTrialEnd(START).toISOString(), END.toISOString());
  const license = { status: "TRIAL_ACTIVE", started_at: START, trial_started_at: START, trial_ends_at: END };
  assert.equal(licenseAllowsAccess(license, new Date(END.getTime() - 1)), true);
  assert.equal(licenseAllowsAccess(license, END), false);
  assert.equal(licenseAllowsAccess({ ...license, trial_ends_at: null }, START), false);
});

test("days remaining uses safe ceiling behavior and never becomes negative", () => {
  assert.equal(trialDaysRemaining(END, START), 14);
  assert.equal(trialDaysRemaining(END, new Date(END.getTime() - 1)), 1);
  assert.equal(trialDaysRemaining(END, END), 0);
  assert.equal(trialDaysRemaining(END, new Date(END.getTime() + 1)), 0);
});

test("mandatory reminder defaults are 5d and 2d, unique, ordered, and bounded", () => {
  assert.deepEqual(DEFAULT_TRIAL_REMINDER_OFFSETS, [5, 2]);
  assert.deepEqual(normalizeReminderOffsets("2,5,2"), [5, 2]);
  assert.throws(() => normalizeReminderOffsets("0,5"), /offsets_invalid/);
  assert.throws(() => normalizeReminderOffsets("14"), /offsets_invalid/);
});

test("reminder copy states exact end time, deactivation effect, retention and upgrade CTA", () => {
  const message = trialReminderMessage({ trialEndsAt: END, upgradeUrl: "https://suite.example.invalid/saas/pricing", offsetDays: 5 });
  assert.match(message.subject, /14-Tage-Testphase.*5 Tagen/);
  assert.match(message.text, /2\. September 2026/);
  assert.match(message.text, /deaktiviert/);
  assert.match(message.text, /Dokument.*Auditdaten/);
  assert.match(message.text, /Reguläres Paket wählen: https:\/\//);
  assert.throws(() => trialReminderMessage({ trialEndsAt: END, upgradeUrl: "http://unsafe.invalid", offsetDays: 2 }), /upgrade_url_invalid/);
});

test("only definite pre-delivery failures retry; ambiguous SMTP outcomes never auto-duplicate", () => {
  assert.equal(classifyTrialDeliveryFailure(Object.assign(new Error("unconfigured"), { deliveryAttempted: false })), "FAILED");
  assert.equal(classifyTrialDeliveryFailure(new Error("socket_lost_after_data")), "DELIVERY_UNKNOWN");
});

test("conversion before or after expiry preserves regular products and trial history", () => {
  for (const [status, now] of [["TRIAL_ACTIVE", START], ["EXPIRED", new Date(END.getTime() + 1)]]) {
    const result = trialBillingStatus({ trial: { commercial_product_key: PAID_TRIAL_PRODUCT_KEY, status, trial_started_at: START, trial_ends_at: END },
      regularLicenses: [{ commercial_product_key: "wb_crm", status: "ACTIVE" }, { commercial_product_key: "wb_docs", status: "ACTIVE" }],
      upgradeUrl: "https://suite.example.invalid/saas/pricing", now });
    assert.equal(result.converted, true);
    assert.deepEqual(result.regularLicenses.map((row) => row.productKey), ["wb_crm", "wb_docs"]);
    assert.ok(result.trial);
  }
});

test("customer and company normalization is stable without storing raw replay keys", () => {
  assert.equal(normalizedCompanyIdentity("  WB—Holding GmbH  "), "wb holding gmbh");
  assert.equal(normalizedCompanyIdentity("WB Holding GmbH"), "wb holding gmbh");
});

test("migration is data-driven, one-time EUR 199, RLS isolated, and deliberately has no invented Price", async () => {
  const sql = await readFile(new URL("../migrations/101_paid_trial_lifecycle.sql", import.meta.url), "utf8");
  assert.match(sql, /wb_business_suite_trial_14d/);
  assert.match(sql, /PAID_TRIAL.*14.*EUR.*19900/s);
  assert.match(sql, /trial_claim_company_once/);
  assert.match(sql, /UNIQUE\(license_id,offset_days\)/);
  assert.match(sql, /trial_reminder_deliveries FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /saas\.tenant_matches\(tenant_id\)/);
  assert.doesNotMatch(sql, /VALUES\s*\(\s*'price_/);
  for (const blocked of ["crm", "flow", "insights", "connect"]) assert.match(sql, new RegExp(`'${blocked}','EXTERNAL_MODULE_NOT_READY'`));
});

test("Green configurator maps only the supplied trial Price and is deterministic and conflict-refusing", async () => {
  const sql = await readFile(new URL("../deployment/configure-paid-trial-price.sql", import.meta.url), "utf8");
  assert.equal(sql.match(/price_1U5VsIE0SiqbbyKf1wdyWTUR/g)?.length, 1);
  assert.doesNotMatch(sql, /price_REAL|stripe_trial_price_id=/);
  assert.match(sql, /paid_trial_days=14/);
  assert.match(sql, /expected_currency='EUR'/);
  assert.match(sql, /expected_amount_minor=19900/);
  assert.match(sql, /billing_interval='ONE_TIME'/);
  assert.match(sql, /amount_minor=19900/);
  assert.match(sql, /LOCK TABLE saas\.stripe_price_offers/);
  assert.match(sql, /paid_trial_price_mapping_conflict/);
  assert.match(sql, /WHERE NOT EXISTS/);
  assert.match(sql, /paid_trial_price_mapping_postcondition_failed/);
  assert.doesNotMatch(sql, /verified_outside_database/);
});

test("worker SQL is idempotent/concurrency-safe, tenant-scoped, non-destructive and excludes regular licenses", async () => {
  const source = await readFile(new URL("../platform/trial-lifecycle.mjs", import.meta.url), "utf8");
  assert.match(source, /ON CONFLICT\(license_id,offset_days\) DO NOTHING/);
  assert.match(source, /FOR UPDATE OF r SKIP LOCKED/);
  assert.match(source, /p\.offer_class='PAID_TRIAL'/);
  assert.match(source, /withTenantContext/);
  assert.match(source, /TRIAL_EXPIRED/);
  assert.doesNotMatch(source, /DELETE FROM/);
});

test("Stripe activation is mapped from a stored active offer and replay never becomes ACTIVE", async () => {
  const source = await readFile(new URL("../platform/commercial-licensing.mjs", import.meta.url), "utf8");
  assert.match(source, /JOIN saas\.stripe_price_offers o ON o\.id=c\.offer_id/);
  assert.match(source, /c\.stripe_price_id=o\.stripe_price_id/);
  assert.match(source, /offer\.offer_class === "PAID_TRIAL"/);
  assert.match(source, /trial_already_claimed/);
  assert.doesNotMatch(source, /alreadyHasTrial\.rowCount \? "ACTIVE"/);
  assert.match(source, /event\.paymentRef/);
});

test("tenant/admin endpoints expose safe status and missing tenant context fails closed", async () => {
  const source = await readFile(new URL("../platform/saas-platform.mjs", import.meta.url), "utf8");
  assert.match(source, /api\/saas\/billing\/status/);
  assert.match(source, /tenant_context_required/);
  assert.match(source, /api\/saas\/admin\/trials/);
  assert.match(source, /converted/);
  assert.doesNotMatch(source, /stripeSecretKey|STRIPE_SECRET_KEY/);
});

test("rollback refuses history loss and worker requires both submission switches literal false", async () => {
  const rollback = await readFile(new URL("../deployment/rollback-paid-trial-lifecycle.sql", import.meta.url), "utf8");
  const worker = await readFile(new URL("../platform/trial-lifecycle-worker.mjs", import.meta.url), "utf8");
  assert.match(rollback, /rollback_refused_paid_trial_history_present/);
  assert.match(worker, /EXTERNAL_SUBMISSION_ENABLED/);
  assert.match(worker, /WB_TENDER_ALLOW_EXTERNAL_SUBMISSION/);
  assert.match(worker, /!== "false"/);
});
