import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {CALCULATION_INPUT_SNAPSHOT_SCHEMA_VERSION} from "../platform/calculation-contract.mjs";

const migration = await readFile(new URL("../migrations/157_versioned_calculation_input_snapshot.sql", import.meta.url), "utf8");
const rollback = await readFile(new URL("../migrations/157_versioned_calculation_input_snapshot.down.sql", import.meta.url), "utf8");

test("schema 4 follows historical database snapshot schemas 1 through 3", () => {
  assert.equal(CALCULATION_INPUT_SNAPSHOT_SCHEMA_VERSION, 4);
  assert.match(migration, /schema_version=4/);
  assert.match(migration, /schema_version<4/);
});

test("migration 157 is additive and retains every historical row", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS contract_version/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS engine_input jsonb/);
  assert.match(migration, /historicalSnapshotRowsChanged',false/);
  assert.doesNotMatch(migration, /UPDATE tender\.calculation_input_snapshots/);
  assert.doesNotMatch(migration, /DELETE FROM tender\.(?:calculation_input_snapshots|calculations|management_outputs)/);
});

test("schema-4 snapshots are immutable and calculations bind exact input scope", () => {
  assert.match(migration, /calculation_input_snapshot_v4_is_immutable/);
  assert.match(migration, /calculation_input_snapshot_scope_mismatch/);
  assert.match(migration, /snapshot_row\.tenant_id IS DISTINCT FROM NEW\.tenant_id/);
  assert.match(migration, /snapshot_row\.lot_key IS DISTINCT FROM coalesce\(NEW\.lot_key,''\)/);
  assert.match(migration, /FOREIGN KEY\(calculation_input_snapshot_id\)/);
});

test("application rollback never removes forensic or business data", () => {
  assert.match(rollback, /additiveColumnsRetained',true/);
  assert.match(rollback, /snapshotRowsDeleted',false/);
  assert.doesNotMatch(rollback, /DROP (?:TABLE|COLUMN)/);
  assert.doesNotMatch(rollback, /DELETE FROM tender\./);
});
