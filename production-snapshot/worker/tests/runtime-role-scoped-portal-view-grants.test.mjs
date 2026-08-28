import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const migration=readFileSync(new URL("../migrations/130_runtime_role_scoped_portal_view_grants.sql",import.meta.url),"utf8");
const rollback=readFileSync(new URL("../migrations/130_runtime_role_scoped_portal_view_grants.down.sql",import.meta.url),"utf8");

test("runtime grants are limited to the two security-invoker portal views",()=>{
  for(const role of ["tender_api_runtime","tender_worker_runtime"])
    assert.match(migration,new RegExp(`GRANT SELECT[\\s\\S]*TO ${role}`));
  for(const view of ["current_tender_company_portal_role_scopes","current_portal_host_capability_truth"])
    assert.match(migration,new RegExp(view));
  assert.doesNotMatch(migration,/GRANT\s+ALL|BYPASSRLS|DISABLE ROW LEVEL SECURITY/i);
  assert.match(migration,/0130-runtime-role-scoped-portal-view-grants/);
});

test("grant rollback revokes only the added view reads",()=>{
  assert.match(rollback,/REVOKE SELECT/);
  assert.match(rollback,/DELETE FROM app\.schema_migrations/);
  assert.doesNotMatch(rollback,/DROP VIEW|DROP TABLE|DELETE FROM tender\./);
});
