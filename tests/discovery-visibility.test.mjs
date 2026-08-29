import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routes = readFileSync(new URL("../platform/autopilot-routes.mjs", import.meta.url), "utf8");
const ui = readFileSync(new URL("../platform/assets/autopilot-navigation.js", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/079_public_source_ingestion_trigger_guard.sql", import.meta.url), "utf8");
const entrypoint = readFileSync(new URL("../deployment/wb-tender-ingestion-entrypoint", import.meta.url), "utf8");

test("overview discovers relevant public notices independently of portal execution scope", () => {
  const overview = routes.slice(routes.indexOf('"/api/autopilot/navigation/overview"'), routes.indexOf('"/api/autopilot/navigation/context/:tenderId"'));
  assert.match(overview, /EXISTS\(SELECT 1 FROM tender\.current_registered_tender_company_portals/);
  assert.doesNotMatch(overview, /JOIN tender\.current_registered_tender_company_portals registered ON registered\.tender_id=r\.tender_id/);
  assert.match(overview, /portal_scope_registered/);
});

test("portal execution and notice detail remain registered-scope protected", () => {
  const context = routes.slice(routes.indexOf('"/api/autopilot/navigation/context/:tenderId"'), routes.indexOf('"/api/autopilot/navigation/context/:tenderId/tasks"'));
  assert.match(context, /requireRegisteredScope\(reply, tender\.id, company\.company_id\)/);
  assert.match(ui, /Nur öffentliche Quelle; Portalzuordnung erforderlich/);
  assert.match(ui, /x\.portal_scope_registered\?/);
});

test("ingestion suppresses only the unscoped pipeline trigger and hard-locks submission", () => {
  assert.match(migration, /current_setting\('wb_tender\.suppress_autopilot_enqueue', true\) = 'true'/);
  assert.match(entrypoint, /EXTERNAL_SUBMISSION_ENABLED:-false.*= false/);
  assert.match(entrypoint, /WB_TENDER_ALLOW_EXTERNAL_SUBMISSION:-false.*= false/);
});
