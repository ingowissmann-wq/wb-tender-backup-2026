import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const inbox=readFileSync(new URL("../platform/inbox-pipeline.mjs",import.meta.url),"utf8");
const routes=readFileSync(new URL("../platform/autopilot-routes.mjs",import.meta.url),"utf8");
const migration=readFileSync(new URL("../migrations/160_global_exact_lot_region_binding.sql",import.meta.url),"utf8");
test("global region pipeline fans out tender-wide relevance to eligible canonical lots",()=>{
 assert.match(inbox,/FROM tender\.current_participation_eligible_lots eligible/);
 assert.match(inbox,/JOIN LATERAL\(/);
 assert.match(inbox,/canonical_lot\.external_id=eligible_lot\.lot_key/);
 assert.match(inbox,/binding\.lot_key=eligible_lot\.lot_key/);
});
test("append-only evaluation refreshes exact persisted lot selection",()=>{
 assert.match(inbox,/exactRegionEvaluationId=created\.rows\[0\]\?\.id/);
 assert.match(inbox,/UPDATE tender\.tender_lot_selections SET region_evaluation_id=\$1/);
 assert.match(inbox,/lot_id=\$5 AND source_lot_id=\$6/);
});
test("lot selection refuses non-exact or inactive evaluations",()=>{
 assert.match(routes,/EXACT_LOT_REGION_MATERIALIZATION_REQUIRED/);
 assert.match(routes,/FROM tender\.current_scoped_region_evaluations/);
 assert.match(routes,/lot_id=\$3/);
 assert.doesNotMatch(routes,/SELECT id FROM tender\.region_evaluations WHERE tender_id=\$1 AND company_id=\$2 ORDER BY evaluation_version DESC LIMIT 1/);
});
test("migration queues every active scope idempotently",()=>{
 assert.match(migration,/INSERT INTO tender\.region_recalculation_jobs/);
 assert.match(migration,/ON CONFLICT\(idempotency_key\) DO NOTHING/);
 assert.match(migration,/0160-global-exact-lot-region-binding/);
});

test("recalculation includes persisted selections and fails closed on incomplete exact bindings",()=>{
 assert.match(inbox,/FROM tender\.tender_lot_selections selection/);
 const worker=readFileSync(new URL("../platform/region-recalculation-worker.mjs",import.meta.url),"utf8");
 assert.match(worker,/selected_targets AS/);
 assert.match(worker,/REGION_EXACT_BINDING_INCOMPLETE/);
 assert.match(worker,/missingExactBindings/);
});
test("durability migration installs indexes and automatically queues future scopes",()=>{
 const durable=readFileSync(new URL("../migrations/161_durable_exact_lot_region_invariant.sql",import.meta.url),"utf8");
 assert.match(durable,/service_relevance_global_region_recalc_idx/);
 assert.match(durable,/tender_lot_lifecycles_eligible_lookup_idx/);
 assert.match(durable,/CREATE TRIGGER configuration_scope_region_recalculation/);
 assert.match(durable,/AFTER INSERT OR UPDATE OF active_region_version_id/);
});

test("persisted selections bypass discovery gates and future selections enqueue repair",()=>{
 const selectedMigration=readFileSync(new URL("../migrations/162_selected_lot_region_invariant.sql",import.meta.url),"utf8");
 assert.match(inbox,/\$6::jsonb IS NOT NULL OR \(t\.data_class='PUBLIC_REAL'/);
 assert.match(inbox,/\$6::jsonb IS NOT NULL OR NOT EXISTS\(SELECT 1 FROM tender\.tender_tombstones/);
 assert.match(selectedMigration,/CREATE TRIGGER tender_lot_selection_region_recalculation/);
 assert.match(selectedMigration,/AFTER INSERT OR UPDATE OF company_id,canonical_service,lot_id,source_lot_id/);
 assert.match(selectedMigration,/migration-0162-selected-lot-region:/);
 assert.match(selectedMigration,/evaluation\.id IS NULL/);
});
