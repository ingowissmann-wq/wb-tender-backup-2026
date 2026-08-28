import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../migrations/122_portal_credential_secret_insert_scope.sql", import.meta.url),
  "utf8",
);
const runtimeMigration = readFileSync(
  new URL("../migrations/108_tender_runtime_rls_and_integrity.sql", import.meta.url),
  "utf8",
);
const routes = readFileSync(
  new URL("../platform/autopilot-routes.mjs", import.meta.url),
  "utf8",
);
const saveRoute = routes.slice(
  routes.indexOf('app.post(\n    "/api/portal-access/:portalId/credentials"'),
  routes.indexOf('app.patch(\n    "/api/portal-access/:portalId/credential-metadata"'),
);
const directCredentialScriptStart = routes.indexOf("const portalNavigationScript =");
const directCredentialScript = routes.slice(
  directCredentialScriptStart,
  routes.indexOf("})();`;", directCredentialScriptStart) + 6,
);

test("new secret insert requires the exact transaction-local company in both runtime scopes", () => {
  assert.match(migration, /CREATE POLICY runtime_insert_scope[\s\S]*FOR INSERT[\s\S]*WITH CHECK/);
  assert.match(
    migration,
    /runtime_company_allowed\(\s*tender\.runtime_uuid_value\('app\.portal_credential_company_id'\)\s*\)/,
  );
  assert.match(
    migration,
    /resolve_runtime_tenants\([\s\S]*runtime_uuid_value\('app\.portal_credential_company_id'\)[\s\S]*runtime_tenant_allowed\(binding\.tenant_id\)/,
  );
  assert.match(migration, /relrowsecurity[\s\S]*relforcerowsecurity/);
  assert.match(migration, /enforce_one_active_portal_company_credential\(\)[\s\S]*SECURITY DEFINER/);
  assert.match(migration, /enforce_one_active_portal_company_credential\(\)[\s\S]*SET search_path=pg_catalog,tender/);
  assert.match(migration, /0122-portal-credential-secret-insert-scope/);
  assert.doesNotMatch(migration, /WITH CHECK\s*\(\s*true\s*\)/i);
  assert.doesNotMatch(migration, /DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY|BYPASSRLS/i);
});

test("credential save installs only an exact transaction-local insert target and remains atomic", () => {
  const beginAt = saveRoute.indexOf('client.query("BEGIN")');
  const targetAt = saveRoute.indexOf("set_config('app.portal_credential_company_id',$1,true)");
  const secretAt = saveRoute.indexOf("INSERT INTO tender.portal_credential_secrets");
  const bindingAt = saveRoute.indexOf("INSERT INTO tender.portal_credential_companies");
  const visibilityAt = saveRoute.indexOf("SELECT id,version,created_at FROM tender.portal_credential_secrets WHERE id=$1");
  const commitAt = saveRoute.lastIndexOf('client.query("COMMIT")');

  assert(beginAt >= 0);
  assert(targetAt > beginAt);
  assert(secretAt > targetAt);
  assert(bindingAt > secretAt);
  assert(visibilityAt > bindingAt);
  assert(commitAt > visibilityAt);
  assert.match(saveRoute, /\[companyId\],[\s\S]*INSERT INTO tender\.portal_credential_secrets/);
  assert.match(saveRoute, /credentialId=crypto\.randomUUID\(\)/);
  assert.doesNotMatch(saveRoute.slice(secretAt, bindingAt), /RETURNING/i);
  assert.match(saveRoute, /INSERT INTO tender\.portal_credential_companies[\s\S]*\[credentialId, companyId\]/);
  assert.match(saveRoute, /credential_binding_visibility_failed/);
  assert.match(saveRoute, /identityCompanies=new Set\(\(req\.identity\.companyIds\|\|\[\]\)\.map\(String\)\)/);
  assert.match(saveRoute, /company_scope_forbidden/);
  assert.match(saveRoute, /catch \(error\) \{[\s\S]*client\.query\("ROLLBACK"\)/);
});

test("out-of-scope and malformed insert targets stay fail-closed", () => {
  assert.match(migration, /EXCEPTION WHEN invalid_text_representation THEN RETURN NULL/);
  assert.match(migration, /runtime_company_allowed/);
  assert.match(migration, /runtime_tenant_allowed/);
  assert.match(runtimeMigration, /runtime_tenant_allowed[\s\S]*runtime_uuid_list\('app\.tenant_ids'\)/);
  assert.match(runtimeMigration, /runtime_company_allowed[\s\S]*runtime_uuid_list\('app\.company_ids'\)/);
});

test("an empty password on an existing direct form never calls the secret replacement route", () => {
  assert.match(directCredentialScript, /if\(Boolean\(username\)!==Boolean\(password\)\)/);
  assert.match(directCredentialScript, /if\(!form\.dataset\.configured&&!username\)/);
  assert.match(
    directCredentialScript,
    /if\(username\)await request\("\/portal-access\/"[\s\S]*?"\/credentials","POST"/,
  );
  assert.match(
    directCredentialScript,
    /await request\("\/portal-access\/"[\s\S]*?"\/credential-metadata","PATCH"/,
  );
});
