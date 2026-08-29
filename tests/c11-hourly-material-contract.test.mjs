import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parameterUnitRules, unitValidation } from "../platform/unit-catalog.mjs";
import { calculateSectorTender } from "../platform/sector-calculation.mjs";

const activation = await readFile(
  new URL("../scripts/isolated-c11-wb-cleaning-approved-activation.sh", import.meta.url),
  "utf8",
);
const migration = await readFile(
  new URL("../migrations/156_c11_hourly_material_contract.sql", import.meta.url),
  "utf8",
);
const rollback = await readFile(
  new URL("../migrations/156_c11_hourly_material_contract.down.sql", import.meta.url),
  "utf8",
);

test("C11 permits hourly material cost without changing its legacy default unit", () => {
  assert.equal(parameterUnitRules.C11.defaultUnitId, "EUR_PER_UNIT");
  assert.ok(parameterUnitRules.C11.allowedUnitIds.includes("EUR_PER_HOUR"));
  assert.equal(unitValidation("C11", "EUR/Stunde").unit.id, "EUR_PER_HOUR");
});

test("hourly C11 uses productive hours as the canonical quantity", () => {
  const result = calculateSectorTender({
    serviceArea: "cleaning",
    parameters: { C01: 15.5, C11: 0.5, C23: 1670 },
    units: { C11: "EUR_PER_HOUR", C23: "HOURS_PER_YEAR" },
    facts: { productiveHours: 2906.38, duration: 48, areas: 29142.6877 },
  });
  assert.equal(result.status, "CALCULATED");
  assert.equal(result.material, 1453.19);
  assert.equal(result.fte, 0.44);
});

test("migration 156 is additive, ledgered and has a non-business-data rollback", () => {
  assert.match(migration, /0156-c11-hourly-material-contract/);
  assert.match(migration, /existingConfigurationChanged',false/);
  assert.match(migration, /ON CONFLICT\(version\) DO NOTHING/);
  assert.match(rollback, /configurationRowsDeleted',false/);
  assert.doesNotMatch(rollback, /DELETE FROM tender\.configuration_/);
});

test("C11 activation is exact-scope, board-approved, atomic and idempotent", () => {
  assert.match(activation, /company_id=15c3c602-aa51-4dd4-adc1-3586dc82e523/);
  assert.match(activation, /profile_id=447c8ef1-39e2-4ec0-a053-0dadd5b01e0b/);
  assert.match(activation, /approved_value=0\.5/);
  assert.match(activation, /approved_unit=EUR_PER_HOUR/);
  assert.match(activation, /version\.version_no=61/);
  assert.match(activation, /BOARD_SELF_APPROVED/);
  assert.match(activation, /active parameter count changed/);
  assert.match(activation, /rerun is idempotent/);
  assert.match(activation, /refusing_non_restore_database/);
});
