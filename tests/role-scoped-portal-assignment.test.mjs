import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const routes=readFileSync(new URL("../platform/autopilot-routes.mjs",import.meta.url),"utf8");
const migration=readFileSync(new URL("../migrations/126_role_scoped_tender_portal_assignments.sql",import.meta.url),"utf8");
const rollback=readFileSync(new URL("../migrations/126_role_scoped_tender_portal_assignments.down.sql",import.meta.url),"utf8");

test("portal confirmation persists an exact role, current tender version and canonical lot",()=>{
  assert.match(routes,/\["DOCUMENT_PORTAL","SUBMISSION_PORTAL"\]\.includes\(portalRole\)/);
  assert.match(routes,/FROM tender\.tender_lot_selections selection/);
  assert.match(routes,/selection\.tender_version_id=\(SELECT version\.id/);
  assert.match(routes,/INSERT INTO tender\.tender_portal_assignments/);
  assert.match(routes,/portal_id,exact_host,portal_role,assignment_source/);
  assert.match(routes,/portalRole,portalHost:portal\.canonical_domain,tenderVersionId/);
  assert.match(routes,/externalWrite:false,transmitted:false/);
});

test("publication services cannot be silently assigned and a missing lot fails closed",()=>{
  assert.match(routes,/tenderCredentialPortalEligibility\(portal\)/);
  assert.match(routes,/lot_selection_required/);
  assert.match(routes,/Portalzuordnung wird los-, gesellschafts-, rollen- und versionsgebunden gespeichert/);
  assert.doesNotMatch(routes,/portalRole\s*=\s*["']SUBMISSION_PORTAL["']/);
});

test("role-scoped migration preserves RLS identity and never enables external submission",()=>{
  assert.match(migration,/ADD COLUMN IF NOT EXISTS portal_role text NOT NULL/);
  assert.match(migration,/tenant_id,company_id,tender_id,canonical_service,coalesce\(source_lot_id,''\),portal_role/);
  assert.match(migration,/credential\.bound_host=lower\(assignment\.exact_host\)/);
  assert.match(migration,/HAVING count\(DISTINCT credential\.id\)=1/);
  assert.match(migration,/security_barrier=true,security_invoker=true/);
  assert.match(migration,/company_tenant\.company_id=assignment\.company_id AND company_tenant\.tenant_id=assignment\.tenant_id/);
  assert.match(migration,/external_submission_enabled',false/);
  assert.doesNotMatch(migration,/\bDELETE FROM tender\./i);
  assert.doesNotMatch(rollback,/\bDELETE FROM tender\./i);
  assert.match(rollback,/retain portal_role/);
});
