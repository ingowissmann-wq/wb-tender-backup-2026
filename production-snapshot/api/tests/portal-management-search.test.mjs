import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalPortalAccessStatus, normalizePortalSearch, searchPortalResults } from "../platform/portal-management-search.mjs";

const ui = readFileSync(new URL("../platform/assets/autopilot-navigation.js", import.meta.url), "utf8"),
  routes = readFileSync(new URL("../platform/autopilot-routes.mjs", import.meta.url), "utf8"),
  worker = readFileSync(new URL("../platform/autopilot-pipeline-worker.mjs", import.meta.url), "utf8");

const portal = (overrides = {}) => ({ portalId:"11111111-1111-4111-8111-111111111111",portalName:"Deutsche eVergabe",operator:"Healy Hudson",domain:"deutsche-evergabe.de",aliases:["e-vergabe"],adapterId:"deutsche-evergabe",portalType:"E-Vergabeportal",loginEntryUrl:"https://deutsche-evergabe.de/login",registrationEntryUrl:"https://deutsche-evergabe.de/register",adapterValidationStatus:"PRODUCTION_VALIDATED",authenticationSupported:true,documentDownloadSupported:true,access:{configured:false,status:"NOT_CONFIGURED"},...overrides });

test("search covers name, operator, domain, alias and registry id", () => {
  const item = portal(), items = [item];
  for (const q of ["Deutsche eVergabe","Healy Hudson","deutsche-evergabe.de","e vergabe",item.portalId])
    assert.equal(searchPortalResults(items,{q}).total,1,q);
});

test("search is case, umlaut, hyphen and whitespace tolerant", () => {
  assert.equal(normalizePortalSearch("DÜSSELDORF-e Vergabe"),normalizePortalSearch("dusseldorf e-vergabe"));
  assert.equal(searchPortalResults([portal({portalName:"Vergabe Düsseldorf"})],{q:"VERGABE-DUSSELDORF"}).total,1);
});

test("filters, reset-equivalent empty query, pagination and null results", () => {
  const items = Array.from({length:51},(_,index)=>portal({portalId:String(index),portalName:`Portal ${index}`,access:{configured:index%2===0,status:index%2===0?"VALID":"NOT_CONFIGURED"}}));
  assert.equal(searchPortalResults(items,{access:"present"}).total,26);
  assert.equal(searchPortalResults(items,{status:"VALID"}).total,26);
  assert.equal(searchPortalResults(items,{page:2,pageSize:25}).items.length,25);
  assert.equal(searchPortalResults(items,{page:3,pageSize:25}).items.length,1);
  assert.equal(searchPortalResults(items,{q:"nicht vorhanden"}).total,0);
  assert.equal(searchPortalResults(items,{q:""}).total,51);
});

test("authoritative status keeps stored credentials distinct from current validation", () => {
  assert.equal(canonicalPortalAccessStatus({configured:false}),"NOT_CONFIGURED");
  assert.equal(canonicalPortalAccessStatus({configured:true}),"CONFIGURED_UNVERIFIED");
  assert.equal(canonicalPortalAccessStatus({configured:true,jobStatus:"RUNNING"}),"VALIDATION_PENDING");
  assert.equal(canonicalPortalAccessStatus({configured:true,sessionEffectiveStatus:"ACTIVE",jobStatus:"SUCCEEDED"}),"VALID");
  assert.equal(canonicalPortalAccessStatus({configured:true,captchaRequired:true}),"CAPTCHA_OR_USER_ACTION_REQUIRED");
  assert.equal(canonicalPortalAccessStatus({configured:true,jobResultCode:"CAPTCHA_MANUELL_ERFORDERLICH"}),"CAPTCHA_OR_USER_ACTION_REQUIRED");
  assert.equal(canonicalPortalAccessStatus({configured:true,sessionEffectiveStatus:"RELOGIN_REQUIRED_REVOKED"}),"EXPIRED");
});

test("UI provides requested keyboard, filter, paging and no secret search fields", () => {
  for (const value of ["Vergabeportal oder Anbieter suchen","Portalname, Betreiber, Domain oder Alias eingeben","Suche zurücksetzen","Kein passendes Vergabeportal gefunden.","data-portal-page","event.key === \"Escape\"","event.key === \"Enter\""]) assert.match(ui,new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  assert.doesNotMatch(ui,/data-portal-filter="(?:password|ciphertext|totp|session)/i);
});

test("portal jobs use persisted dedicated scope and read-after-write exact binding", () => {
  const route = routes.slice(routes.indexOf('"/api/portal-access/jobs/:jobId"'),routes.indexOf('"/api/management-inbox/autopilot/:tenderId/jobs"',routes.indexOf('"/api/portal-access/jobs/:jobId"')));
  assert.match(route,/tender\.autopilot_queue/);
  assert.match(route,/activeCredentialForCompany\(row\.portal_id, row\.company_id\)/);
  assert.match(route,/credential_version_superseded/);
  assert.doesNotMatch(route,/requireRegisteredScope/);
  assert.match(worker,/PORTAL_SESSION_READ_AFTER_WRITE_FAILED/);
  assert.match(worker,/portal_id=\$2 AND company_id=\$3 AND credential_id=\$4/);
});

test("portal listing is read-only and restricted to one selected company", () => {
  const route = routes.slice(routes.indexOf('app.get("/api/portals"'),routes.indexOf("const PORTAL_SUBMISSION_GRANT_PHRASE"));
  assert.doesNotMatch(route,/await discoverPortals/);
  assert.match(route,/const companyAccesses = \[requestedCompany\]/);
  assert.match(route,/tender_company_scope_forbidden/);
});
