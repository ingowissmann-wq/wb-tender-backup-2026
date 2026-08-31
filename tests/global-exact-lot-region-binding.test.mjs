import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const inbox=readFileSync(new URL("../platform/inbox-pipeline.mjs",import.meta.url),"utf8");
const routes=readFileSync(new URL("../platform/autopilot-routes.mjs",import.meta.url),"utf8");
const migration=readFileSync(new URL("../migrations/160_global_exact_lot_region_binding.sql",import.meta.url),"utf8");
test("global region pipeline fans out tender-wide relevance to eligible canonical lots",()=>{
 assert.match(inbox,/JOIN tender\.current_participation_eligible_lots eligible_lot/);
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
