import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migration=fs.readFileSync(new URL("../migrations/134_runtime_child_scope_rls.sql",import.meta.url),"utf8");
const rollback=fs.readFileSync(new URL("../migrations/134_runtime_child_scope_rls.down.sql",import.meta.url),"utf8");
const acceptance=fs.readFileSync(new URL("./runtime-child-scope-rls-staging-acceptance.sql",import.meta.url),"utf8");

test("migration 134 force-isolates workflow children through protected parents",()=>{
  assert.match(migration,/FORCE ROW LEVEL SECURITY/);
  assert.match(migration,/CREATE POLICY runtime_parent_scope/);
  assert.match(migration,/portal_account_identity_evidence/);
  assert.match(migration,/external_submission_continuations/);
  assert.match(migration,/submission_state_transitions/);
  assert.match(migration,/bid_package_id IS NOT NULL OR calculation_id IS NOT NULL/);
  assert.match(migration,/app\.schema_migrations/);
  assert.doesNotMatch(migration,/DELETE FROM tender\./);
});

test("migration 134 has an explicit reversible rollback",()=>{
  assert.match(rollback,/DROP POLICY IF EXISTS runtime_parent_scope/);
  assert.match(rollback,/NO FORCE ROW LEVEL SECURITY/);
  assert.match(rollback,/DISABLE ROW LEVEL SECURITY/);
  assert.match(rollback,/DELETE FROM app\.schema_migrations/);
});

test("staging acceptance covers every active company and empty runtime scope",()=>{
  assert.match(acceptance,/enterprise_company_links/);
  assert.match(acceptance,/WHERE company\.active/);
  assert.match(acceptance,/SET LOCAL ROLE tender_api_runtime/);
  assert.match(acceptance,/empty_runtime_scope_exposed_rows/);
  assert.match(acceptance,/rows_exposed_to_multiple_active_companies/);
  assert.match(acceptance,/'protectedTables'/);
});
