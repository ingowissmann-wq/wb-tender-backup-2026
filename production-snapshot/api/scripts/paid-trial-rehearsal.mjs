import { readFile } from "node:fs/promises";
import pg from "pg";

if (process.env.WB_TENDER_ISOLATION_TEST_DATABASE !== "true") throw new Error("refusing_non_test_database");
if (!process.env.DATABASE_URL) throw new Error("database_url_missing");
if (process.env.EXTERNAL_SUBMISSION_ENABLED !== "false" || process.env.WB_TENDER_ALLOW_EXTERNAL_SUBMISSION !== "false") throw new Error("external_submission_flags_must_be_false");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const root = new URL("../", import.meta.url);
const sql = (file) => readFile(new URL(file, root), "utf8");
try {
  await pool.query(await sql("migrations/101_paid_trial_lifecycle.sql"));
  await pool.query(await sql("migrations/101_paid_trial_lifecycle.sql"));
  const contract = (await pool.query(`SELECT p.product_key,p.offer_class,p.paid_trial_days,p.expected_currency,p.expected_amount_minor,
      (SELECT count(*)::int FROM saas.commercial_product_modules m WHERE m.commercial_product_key=p.product_key) safe_modules,
      (SELECT count(*)::int FROM saas.commercial_product_blockers b WHERE b.commercial_product_key=p.product_key) blockers,
      (SELECT count(*)::int FROM saas.stripe_price_offers o WHERE o.commercial_product_key=p.product_key AND o.status='ACTIVE') active_prices
    FROM saas.products p WHERE p.product_key='wb_business_suite_trial_14d'`)).rows[0];
  if (!contract || contract.offer_class !== "PAID_TRIAL" || contract.paid_trial_days !== 14
    || contract.expected_currency !== "EUR" || Number(contract.expected_amount_minor) !== 19900
    || contract.safe_modules !== 6 || contract.blockers !== 4 || contract.active_prices !== 0) throw new Error("paid_trial_catalog_contract_failed");
  const rls = (await pool.query(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class
    WHERE oid='saas.trial_reminder_deliveries'::regclass`)).rows[0];
  if (!rls?.relrowsecurity || !rls?.relforcerowsecurity) throw new Error("paid_trial_rls_not_forced");
  console.log(JSON.stringify({ passed: true, migration: 101, reapplied: true, rollbackScript: "deployment/rollback-paid-trial-lifecycle.sql",
    productKey: contract.product_key, reminderDefaults: [5, 2], safeModules: contract.safe_modules, blockers: contract.blockers,
    realStripePriceMapped: false, externalSubmissionEnabled: false }));
} finally { await pool.end(); }
