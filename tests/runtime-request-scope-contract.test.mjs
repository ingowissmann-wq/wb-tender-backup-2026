import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("server binds authenticated identities to a request-scoped runtime pool", async () => {
  const source = await readFile(new URL("../platform/server.mjs", import.meta.url), "utf8");
  assert.match(source, /createRequestScopedPool/);
  assert.match(source, /runRequest/);
  assert.match(source, /await requestDatabase\.bindIdentity\(identity\)/);
  assert.match(source, /releaseRequest/);
});

test("migration replaces singular configuration RLS with runtime tenant scope", async () => {
  const source = await readFile(new URL("../migrations/159_runtime_request_scope.sql", import.meta.url), "utf8");
  for (const table of ["configuration_scopes", "configuration_versions", "region_profile_versions", "region_profile_rules", "region_evaluations", "region_recalculation_jobs"]) {
    assert.match(source, new RegExp(table));
  }
  assert.match(source, /tender\.runtime_tenant_allowed\(tenant_id\)/);
  assert.doesNotMatch(source, /BYPASSRLS|GRANT\s+ALL/i);
});
