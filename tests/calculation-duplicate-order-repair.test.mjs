import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migration131 = fs.readFileSync(new URL("../migrations/131_calculation_version_concurrency.sql", import.meta.url), "utf8");
const migration132 = fs.readFileSync(new URL("../migrations/132_calculation_duplicate_order_repair.sql", import.meta.url), "utf8");

test("duplicate preservation cannot become the latest commercial calculation", () => {
  assert.match(migration131, /least\(minimum\.min_version,0\)-row_number\(\)/);
  assert.match(migration132, /newArchiveVersion/);
  assert.doesNotMatch(migration131, /max_version\+row_number/);
});

test("metadata-only renumbering cannot invalidate packages or approvals", () => {
  for (const migration of [migration131, migration132]) {
    assert.match(migration, /DISABLE TRIGGER calculation_invalidates_package/);
    assert.match(migration, /ENABLE TRIGGER calculation_invalidates_package/);
  }
});

test("final-context repair is fail-closed and requires exact business equality", () => {
  assert.match(migration132, /final\.transmitted=false AND final\.binding_valid=false/);
  assert.match(migration132, /selected_calculation\.totals=management_calculation\.totals/);
  assert.match(migration132, /scenario_assumptions IS NOT DISTINCT FROM management_calculation\.scenario_assumptions/);
  assert.match(migration132, /businessDataEqual',true/);
  assert.match(migration132, /externalWrite',false/);
});
