import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const routes=fs.readFileSync(new URL("../platform/autopilot-routes.mjs",import.meta.url),"utf8");
const ui=fs.readFileSync(new URL("../platform/assets/autopilot-navigation.js",import.meta.url),"utf8");
const loginMigration=fs.readFileSync(new URL("../migrations/114_portal_login_contract_and_submission_validation.sql",import.meta.url),"utf8");
const regionMigration=fs.readFileSync(new URL("../migrations/115_versioned_region_zone_management.sql",import.meta.url),"utf8");
const connectorMigration=fs.readFileSync(new URL("../migrations/116_remaining_portal_connector_contracts.sql",import.meta.url),"utf8");

test("authoritatively discovered portal targets are bound without touching credentials or companies",()=>{
  for(const target of [
    "https://bieterzugang.deutsche-evergabe.de/evergabe.bieter/login.aspx",
    "https://www.meinauftrag.rib.de/dashboard/index",
    "https://www.meinauftrag.rib.de/public/registerCompany",
    "https://login.vergabe24.de/Account/Login",
    "https://www.evergabe.de/anmelden",
    "https://www.evergabe.de/konto-erstellen",
    "https://my.vergabe.bayern.de/",
  ]) assert.match(loginMigration,new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  assert.doesNotMatch(loginMigration,/UPDATE\s+tender\.portal_credential_(?:secrets|companies)/i);
  assert.doesNotMatch(loginMigration,/DELETE\s+FROM/i);
});

test("submission validation is non-binding and immutable",()=>{
  assert.match(routes,/PORTAL_SUBMISSION_ADAPTERS_NON_BINDING_VALIDATED/);
  assert.match(routes,/globalKillSwitchPreserved:true/);
  assert.match(loginMigration,/CHECK\(external_write=false\)/);
  assert.match(loginMigration,/CHECK\(transmitted=false\)/);
  assert.match(loginMigration,/protect_portal_submission_adapter_validation/);
});

test("region changes are versioned, audited and deletion protected",()=>{
  assert.match(regionMigration,/region_zones_one_active_code_idx/);
  assert.match(regionMigration,/historical_region_zone_immutable/);
  assert.match(regionMigration,/region_zone_delete_protected/);
  assert.match(regionMigration,/protect_region_zone_event/);
  assert.match(routes,/\/api\/regions\/:id\/versions/);
  assert.match(routes,/\/api\/regions\/:id\/retire/);
  assert.match(routes,/region_zone_version_conflict/);
  assert.match(ui,/Umzugsworkflow/);
  assert.match(ui,/Versionshistorie/);
  assert.match(ui,/Stilllegen/);
});

test("missing target offers configuration while verified expired sessions offer re-login",()=>{
  assert.match(ui,/data-login-configure/);
  assert.match(ui,/>Portalzugang konfigurieren</);
  assert.match(ui,/data-login-portal/);
  assert.match(ui,/Erneut anmelden/);
});

test("remaining discovery and Cosinex hosts have exact connector contracts without capability inflation",()=>{
  assert.match(connectorMigration,/canonical_domain='ted\.europa\.eu' AND adapter_id='ted-source'/);
  assert.match(connectorMigration,/adapter_id='ted-discovery'/);
  assert.match(connectorMigration,/'cosinex-vmp-public','1\.0\.0','2\.0\.0','vergabemarktplatz\.brandenburg\.de'/);
  assert.match(connectorMigration,/'PUBLIC_DOCUMENT_ACCESS','PUBLIC_ARCHIVE_DOWNLOAD'/);
  assert.match(connectorMigration,/'submissionEnabled',false/);
  assert.doesNotMatch(connectorMigration,/UPDATE\s+tender\.portal_credential_secrets/i);
  assert.doesNotMatch(connectorMigration,/DELETE\s+FROM/i);
});
