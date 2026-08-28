import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routes = readFileSync(new URL("../platform/autopilot-routes.mjs", import.meta.url), "utf8");
const ui = readFileSync(new URL("../platform/assets/inbox-regions.js", import.meta.url), "utf8");
const ingestion = readFileSync(new URL("../platform/source-ingestion.mjs", import.meta.url), "utf8");
const lifecycle = readFileSync(new URL("../scripts/reclassify-notice-lifecycle.mjs", import.meta.url), "utf8");
const acceptanceFixtures = readFileSync(new URL("../scripts/create-internal-acceptance-fixtures.mjs", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/123_canonical_lot_context_continuity.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../migrations/123_canonical_lot_context_continuity.down.sql", import.meta.url), "utf8");

test("every lifecycle writer materializes canonical lot identity", () => {
  assert.match(ingestion, /INSERT INTO tender\.lots\(tender_id,external_id,title,deadline\)/);
  assert.match(lifecycle, /INSERT INTO tender\.lots\(tender_id,external_id,title,deadline,source_reference_id\)/);
  assert.match(migration, /canonical_lot_context_continuity/);
  assert.match(migration, /AFTER INSERT OR UPDATE OF lot_key,offer_deadline,is_current/);
  assert.match(acceptanceFixtures, /INSERT INTO tender\.lots\(tender_id,external_id,title,deadline\)/);
  assert.match(acceptanceFixtures, /INSERT INTO tender\.tender_lot_lifecycles/);
  assert.match(acceptanceFixtures, /notice_id,lot_id,lot_key,company_id/);
});

test("lot selection is an exact transactional canonical binding", () => {
  assert.match(routes, /SELECT pg_advisory_xact_lock/);
  assert.match(routes, /INSERT INTO tender\.tender_lot_selections/);
  assert.match(routes, /JOIN tender\.lots lot ON lot\.id=selection\.lot_id/);
  assert.match(routes, /INSERT INTO tender\.enrichment_context_bindings/);
  assert.match(routes, /LOT_SELECTION_CONTEXT_NOT_CANONICAL/);
  assert.match(routes, /'EXPLICIT_SELECTION'/);
  assert.doesNotMatch(routes, /selection\.selected_at|selected_by=excluded\.selected_by,selected_at/);
  assert.doesNotMatch(routes, /SELECT id,external_id FROM tender\.lots[^\n]+UNION ALL SELECT el\.id/);
});

test("actions accept only current company-lot enrichment bindings", () => {
  assert.match(routes, /enrichmentInitializableActions/);
  assert.match(routes, /VERALTETER_ODER_FREMDER_ENRICHMENTKONTEXT/);
  assert.match(routes, /JOIN tender\.enrichment_context_bindings binding/);
  assert.match(routes, /tenant_scope_forbidden/);
  assert.match(routes, /LOT_SELECTION_REQUIRED/);
  assert.match(routes, /lot_id: lot\.rows\[0\]\?\.canonical_lot_id \|\| null/);
});

test("UI permits atomic enrichment initialization but never invents a lot", () => {
  assert.match(ui, /initializableMissing = missing\.filter\(\(key\) => key !== "enrichment_version_id"\)/);
  assert.match(ui, /data-select-participation-lot/);
  assert.match(ui, /data-select-participation-lot/);
  assert.doesNotMatch(ui, /LOT-0000/);
});

test("migration is additive and rollback preserves productive data", () => {
  assert.doesNotMatch(migration, /\b(?:DELETE|TRUNCATE)\b/i);
  assert.match(rollback, /DELETE FROM app\.schema_migrations WHERE version='0123-canonical-lot-context-continuity'/);
  assert.doesNotMatch(rollback.replace(/DELETE FROM app\.schema_migrations[^;]+;/, ""), /\b(?:DELETE|TRUNCATE)\b/i);
  assert.match(rollback, /DROP TRIGGER IF EXISTS canonical_lot_context_continuity/);
  assert.match(rollback, /preserve every canonical lot/);
});
