import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalPortalUrl, containsSecret, publicCredential } from "../platform/portal-credentials.mjs";

const routes = readFileSync(new URL("../platform/autopilot-routes.mjs", import.meta.url), "utf8");
const ui = readFileSync(new URL("../platform/assets/autopilot-navigation.js", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/098_portal_registry_verified_entry_links.sql", import.meta.url), "utf8");
const canaryFixture = readFileSync(new URL("../scripts/portal-access-canary-fixture.sql", import.meta.url), "utf8");

test("portal credential responses expose masked metadata but no encrypted or clear secret material", () => {
  const record = { id:"credential", ciphertext:Buffer.from("secret-cipher"), iv:Buffer.from("secret-iv"), auth_tag:Buffer.from("secret-tag"), username_masked:"a***@example.de", internal_label:"Einkauf", contact_person:"Verantwortung", notes:"Ohne Geheimnis", registration_status:"REGISTRIERT", login_status:"LOGIN_BESTAETIGT", mfa_required_state:true, last_manual_check_at:"2026-08-19T00:00:00Z", submission_capable:false, status:"ACTIVE" };
  const output = publicCredential(record, { manage:true });
  assert.equal(output.usernameMasked, "a***@example.de");
  assert.equal(output.registrationStatus, "REGISTRIERT");
  assert.equal(output.loginStatus, "LOGIN_BESTAETIGT");
  assert.equal(containsSecret(output, ["secret-cipher","secret-iv","secret-tag"]), false);
  for (const key of ["ciphertext","iv","auth_tag","password","totpSeed","recoveryCodes"]) assert.equal(Object.hasOwn(output,key), false);
});

test("login and registration registry entries are HTTPS and exact-host allowlisted", () => {
  assert.equal(canonicalPortalUrl("https://portal.example.de/login","portal.example.de").href, "https://portal.example.de/login");
  assert.throws(() => canonicalPortalUrl("http://portal.example.de/login","portal.example.de"));
  assert.throws(() => canonicalPortalUrl("https://foreign.example.org/login","portal.example.de"));
});

test("metadata updates remain company-scoped and audits exclude notes, usernames and secrets", () => {
  const route = routes.slice(routes.indexOf('"/api/portal-access/:portalId/credential-metadata"'), routes.indexOf('"/api/portal-access/:portalId/credentials"', routes.indexOf('"/api/portal-access/:portalId/credential-metadata"')));
  assert.match(route,/accessibleCompanies\(req\.identity\)/);
  assert.match(route,/scope\.company_id=\$10::uuid AND scope\.active=true/);
  assert.match(route,/portal_credential_metadata_updated/);
  assert.doesNotMatch(route,/JSON\.stringify\(\{[^}]*notes|JSON\.stringify\(\{[^}]*username|JSON\.stringify\(\{[^}]*password/s);
  assert.doesNotMatch(ui,/localStorage\.setItem\([^\n]*(?:password|username|totp|secret)/i);
});

test("schema stores separate honest access states and no MFA secrets", () => {
  for (const value of ["NICHT_REGISTRIERT","REGISTRIERUNG_OFFEN","REGISTRIERT","LOGIN_UNGEPRUEFT","LOGIN_BESTAETIGT","MFA_ERFORDERLICH","ZUGANG_GESPERRT","ZUGANG_ABGELAUFEN","MANUELLE_PRUEFUNG"]) assert.match(migration,new RegExp(value));
  assert.doesNotMatch(migration,/totp_seed|mfa_code|recovery_code/i);
});

test("an officially documented target that redirects to a portal 404 is not seeded", () => {
  assert.doesNotMatch(canaryFixture, /register-Company/);
  assert.match(canaryFixture, /registration_entry_url[\s\S]*NULL,NULL/);
});

test("tender portal lookup is fail-closed to the authenticated company and returns only public credential metadata", () => {
  const route = routes.slice(routes.indexOf('"/api/portal-access/for-tender/:tenderId"'), routes.indexOf('"/api/portal-access/:portalId/tenders"'));
  assert.match(route,/visibleTender\(req, reply, req\.params\.tenderId\)/);
  assert.match(route,/accessibleCompanies\(req\.identity\)/);
  assert.match(route,/company_scope_forbidden/);
  assert.match(route,/latestCredentialTruthForCompany\(registeredScope\.portal_id, requestedCompany\)/);
  assert.match(route,/publicCredential\(scopedCredential, \{ manage: portalManage\(req\.identity\) \}\)/);
  assert.match(route,/canManage: portalManage\(req\.identity\)/);
  for (const forbidden of ["ciphertext", "auth_tag", "password", "totpSeed", "recoveryCodes"]) assert.doesNotMatch(route, new RegExp(`credential\\.${forbidden}`));
});
