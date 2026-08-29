import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const migration=await readFile(new URL("../migrations/155_c23_canonical_calculation_contract.sql",import.meta.url),"utf8");
const rollback=await readFile(new URL("../migrations/155_c23_canonical_calculation_contract.down.sql",import.meta.url),"utf8");

test("migration 155 adds only the isolated sandbox authorization contract",()=>{
  assert.match(migration,/0155-c23-canonical-calculation-contract/);
  assert.match(migration,/INSERT INTO iam\.permissions\(code\)/);
  assert.match(migration,/tender\.calculation\.sandbox/);
  assert.match(migration,/role_row\.code IN\('administrator','calculation'\)/);
  assert.match(migration,/defaultValueCreated',false/);
  assert.match(migration,/existingConfigurationChanged',false/);
  assert.match(migration,/existingCalculationsChanged',false/);
  assert.doesNotMatch(migration,/INSERT INTO tender\.configuration_(?:changes|versions|active_parameters|scopes)/);
  assert.doesNotMatch(migration,/\bC23\b[^\n]*(?:1600|2080)/);
});

test("migration 155 rollback preserves business and configuration data",()=>{
  assert.match(rollback,/DELETE FROM iam\.role_permissions/);
  assert.match(rollback,/NOT EXISTS\([\s\S]*iam\.role_permissions/);
  assert.doesNotMatch(rollback,/DELETE FROM tender\./);
  assert.doesNotMatch(rollback,/DROP TABLE|TRUNCATE/);
  assert.match(rollback,/businessRowsDeleted',false/);
  assert.match(rollback,/configurationRowsDeleted',false/);
  assert.match(rollback,/calculationRowsDeleted',false/);
});
