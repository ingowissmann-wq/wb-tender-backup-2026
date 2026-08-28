import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validTenantId, withTenantContext } from "../platform/tenant-context.mjs";

const tenant = "11111111-1111-4111-8111-111111111111";
const actor = "22222222-2222-4222-8222-222222222222";

test("tenant context is transaction-local and always rolled back or committed", async () => {
  const calls = [];
  const client = { query: async (sql, params=[]) => { calls.push([sql, params]); return { rows: [] }; }, release: () => calls.push(["RELEASE", []]) };
  const pool = { connect: async () => client };
  await withTenantContext(pool, { tenantId: tenant, actorUserId: actor }, async (db) => db.query("SELECT 1"));
  assert.deepEqual(calls.map(([sql]) => sql), ["BEGIN", "SELECT set_config('app.tenant_id',$1,true)", "SELECT set_config('app.actor_user_id',$1,true)", "SELECT 1", "COMMIT", "RELEASE"]);
  assert.equal(calls[1][1][0], tenant);
  assert.equal(validTenantId(""), false);
  await assert.rejects(() => withTenantContext(pool, {}, async () => {}), /tenant_context_required/);
});

test("migration forces RLS over every customer data module and defaults demo off", async () => {
  const sql = await readFile(new URL("../migrations/081_tenant_data_plane.sql", import.meta.url), "utf8");
  for (const table of ["crm_accounts","crm_contacts","csm_customers","blocks","employee_profiles","files","tasks","jobs","tender_workspaces","tender_documents","portal_credentials","submission_drafts"])
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS tenant_portal\\.${table}\\(`));
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /saas\.tenant_matches\(tenant_id\)/);
  assert.match(sql, /demo_data_enabled boolean NOT NULL DEFAULT false/);
  assert.match(sql, /example\.invalid/);
  assert.doesNotMatch(sql, /WB-Cleaning|WB-Security|WB-Facilitys|WB-Holding/);
  assert.match(sql, /external_transmitted boolean NOT NULL DEFAULT false CHECK\(external_transmitted=false\)/);
});

test("SaaS identities are denied all legacy WB Tender routes", async () => {
  const server = await readFile(new URL("../platform/server.mjs", import.meta.url), "utf8");
  assert.match(server, /saas_legacy_data_plane_forbidden/);
  assert.match(server, /identity\.companyIds = identity\.saas\.companyIds/);
  const platform = await readFile(new URL("../platform/saas-platform.mjs", import.meta.url), "utf8");
  assert.match(platform, /row\.tenant_kind === "INTERNAL" \? .* : \[\]/);
});

test("file download, search, list and export routes enter tenant context", async () => {
  const routes = await readFile(new URL("../platform/tenant-portal.mjs", import.meta.url), "utf8");
  assert.match(routes, /modules\/docs\/files\/:id\/download/);
  assert.match(routes, /tenant_portal\.files WHERE tenant_id=\$1 AND id=\$2/);
  assert.match(routes, /req\.query\?\.q/);
  assert.match(routes, /modules\/:module\/export/);
  assert.match(routes, /withTenantContext\(pool, req\.tenant/);
});

test("WB mapping backfill is asserted, auditable, reversible and does not rewrite business rows", async () => {
  const backfill = await readFile(new URL("../deployment/backfill-wb-internal-tenant.sql", import.meta.url), "utf8");
  const rollback = await readFile(new URL("../deployment/rollback-wb-internal-tenant-backfill.sql", import.meta.url), "utf8");
  assert.match(backfill, /wb_company_count_assertion_failed/);
  assert.match(backfill, /source_fingerprint/);
  assert.match(backfill, /tenant_kind.*'INTERNAL'/s);
  assert.doesNotMatch(backfill, /UPDATE tender\.|DELETE FROM tender\.|INSERT INTO tender\./);
  assert.match(rollback, /rollback_scope_mismatch/);
  assert.match(rollback, /rollback_refused_tenant_has_lifecycle_rows/);
});
