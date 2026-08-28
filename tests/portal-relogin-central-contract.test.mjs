import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { portalLoginAction } from "../platform/portal-login-action.mjs";

const base = {
  tenderId: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  portalId: "33333333-3333-4333-8333-333333333333",
  configured: true,
  authenticationTargetConfigured: true,
};

test("expired login-capable company credential always exposes re-login despite stale document diagnostics", () => {
  for (const accessStatus of ["DOCUMENT_NOT_FOUND", "ACCESS_DENIED", "PORTAL_UNREACHABLE", "SESSION_EXPIRED"])
    assert.deepEqual(
      portalLoginAction({ ...base, accessStatus, sessionStatus: "EXPIRED", sessionEffectiveStatus: "RELOGIN_REQUIRED_EXPIRED" }),
      {
        type: "START_LOGIN",
        label: "Erneut anmelden",
        reason: "SESSION_EXPIRED",
        binding: { tender_id: base.tenderId, company_id: base.companyId, portal_id: base.portalId, lot_key: "" },
      },
    );
});

test("missing verified authentication target remains fail-closed", () => {
  const action = portalLoginAction({ ...base, authenticationTargetConfigured: false, sessionEffectiveStatus: "RELOGIN_REQUIRED_EXPIRED" });
  assert.equal(action.type, "AUTHENTICATION_TARGET_UNAVAILABLE");
});

test("temporary portal outage retains a safe re-login action", () => {
  const action=portalLoginAction({...base,accessStatus:"PORTAL_UNREACHABLE",lastError:"PORTAL_NICHT_ERREICHBAR",sessionEffectiveStatus:null});
  assert.equal(action.type,"START_LOGIN");
  assert.equal(action.label,"Erneut anmelden");
  assert.equal(action.reason,"PORTAL_TEMPORARILY_UNAVAILABLE");
});

test("legacy image-submit login forms remain supported by the semantic connector", () => {
  const source = fs.readFileSync(new URL("../platform/semantic-browser-auth.mjs", import.meta.url), "utf8");
  assert.match(source, /input\[type="image"\]/);
});

test("public-document portals retain re-login for an expired company account", () => {
  const action = portalLoginAction({
    ...base,
    publicDocumentAccess: true,
    portalOpenAvailable: true,
    accessStatus: "DOCUMENT_NOT_FOUND",
    sessionStatus: "ACTIVE",
    sessionEffectiveStatus: "RELOGIN_REQUIRED_EXPIRED",
  });
  assert.equal(action.type, "START_LOGIN");
  assert.equal(action.label, "Erneut anmelden");
});

test("public-document portals retain re-login when the scoped session is absent", () => {
  const action = portalLoginAction({
    ...base,
    publicDocumentAccess: true,
    portalOpenAvailable: false,
    accessStatus: "SESSION_MISSING",
    sessionStatus: null,
    sessionEffectiveStatus: null,
  });
  assert.equal(action.type, "START_LOGIN");
  assert.equal(action.label, "Erneut anmelden");
});

test("login continuation permits a configured account on a public-document portal", () => {
  const routes = fs.readFileSync(new URL("../platform/autopilot-routes.mjs", import.meta.url), "utf8");
  assert.match(routes, /!credential\s*&&\s*\(portal\.login_strategy === "PUBLIC_DOCUMENT_ACCESS"/);
  const continuation = routes.slice(routes.indexOf('"/api/portal-access/:portalId/login-continuations"'), routes.indexOf('"/api/portal-access/login-continuations/:continuationId/status"'));
  assert.match(continuation, /requireRegisteredScope\(/);
  assert.doesNotMatch(continuation, /resolveDocumentScope\(/);
  assert.match(continuation, /SELECT enrichment\.id enrichment_version_id/);
});

test("portal authentication is an explicitly allowed queue action", () => {
  const migration = fs.readFileSync(new URL("../migrations/117_portal_authentication_queue_action.sql", import.meta.url), "utf8");
  assert.match(migration, /'START_PORTAL_AUTHENTICATION'/);
  assert.doesNotMatch(migration, /DELETE\s+FROM/i);
});

test("continuation polling does not expire an active login job", () => {
  const routes = fs.readFileSync(new URL("../platform/autopilot-routes.mjs", import.meta.url), "utf8");
  assert.match(routes, /\["PENDING", "QUEUED", "CLAIMED", "RUNNING"\]\.includes\(loginJob\.status\)/);
  assert.match(routes, /status: "LOGIN_STARTED"/);
  assert.match(routes, /status: "LOGIN_RETRY_SCHEDULED"/);
  assert.match(routes, /documentContinuation: "NO_BOUND_DOCUMENT_CONTEXT"/);
  assert.match(routes, /WHEN count\(id\)=0 THEN 'NO_BOUND_DOCUMENT_CONTEXT'/);
  assert.match(routes, /Number\(row\.affected_documents \|\| 0\) > 0/);
  assert.match(routes, /resumeAction: "AWAIT_BOUND_DOCUMENT_REFERENCE"/);
});

test("scheduled login retries receive a fresh execution window and are not timed out while waiting", () => {
  const worker = fs.readFileSync(new URL("../platform/autopilot-pipeline-worker.mjs", import.meta.url), "utf8");
  const claim = worker.slice(worker.indexOf("export async function claimQueue"));
  assert.doesNotMatch(claim, /status IN\('PENDING','QUEUED','CLAIMED','RUNNING','RETRY'\)/);
  assert.match(claim, /status IN\('PENDING','QUEUED'\)/);
  assert.match(claim, /status IN\('CLAIMED','RUNNING'\)/);
  assert.match(claim, /started_at=now\(\)/);
  assert.match(claim, /timeout_at=CASE WHEN action_type IN\('START_PORTAL_AUTHENTICATION','TEST_PORTAL_CONNECTION','TEST_DOCUMENT_FETCH'\) THEN now\(\)\+interval '3 minutes'/);
});

test("an interactive reconnect failure is terminal and preserves its first safe diagnostic", () => {
  const worker = fs.readFileSync(new URL("../platform/autopilot-pipeline-worker.mjs", import.meta.url), "utf8");
  assert.match(worker, /interactiveLoginAttempt=item\.action_type==="START_PORTAL_AUTHENTICATION"/);
  assert.match(worker, /retry=!interactiveLoginAttempt&&!terminalCodes\.has\(code\)/);
  assert.match(worker, /error_detail_safe=\$5/);
  const routes = fs.readFileSync(new URL("../platform/autopilot-routes.mjs", import.meta.url), "utf8");
  assert.match(routes, /detail: loginJob\.error_detail_safe \|\| null/);
  assert.match(routes, /clientContractVersion: "reconnect-v36"/);
  assert.match(routes, /status === "MFA_REQUIRED"/);
  assert.match(routes, /MFA-Anmeldung erneut starten/);
});

test("reconnect is correlated, short-lived, scope-bound and never equates opening a link with login success", () => {
  const routes = fs.readFileSync(new URL("../platform/autopilot-routes.mjs", import.meta.url), "utf8");
  const reconnect = routes.slice(routes.indexOf('"/api/portal-access/:portalId/login-continuations"'), routes.indexOf('"/api/portal-access/login-continuations/:continuationId/status"'));
  const status = routes.slice(routes.indexOf('"/api/portal-access/login-continuations/:continuationId/status"'), routes.indexOf('"/api/portal-access/login-continuations/:continuationId/status"') + 16000);
  assert.match(reconnect, /correlationToken = crypto\.randomBytes\(32\)/);
  assert.match(reconnect, /correlation_token_hash/);
  assert.match(reconnect, /tender_version_id,enrichment_version_id,blocked_action/);
  assert.match(reconnect, /interactionMode: "MANAGED_CONNECTOR"/);
  assert.doesNotMatch(reconnect, /externalUrl:/);
  assert.match(status, /correlation_token_hash=\$4/);
  assert.match(status, /verification_status\)='ACTIVE'/);
  assert.match(status, /correlation_consumed_at=coalesce/);
});

test("both production UIs use the managed connector and refresh only after a verified session", () => {
  for (const relative of ["../platform/assets/inbox-regions.js", "../platform/assets/autopilot-navigation.js"]) {
    const ui = fs.readFileSync(new URL(relative, import.meta.url), "utf8");
    const start = Math.max(ui.indexOf('event.target.closest?.("[data-portal-login]")'), ui.indexOf('event.target.closest?.("[data-login-portal]")'));
    const handler = ui.slice(start, start + 9000);
    assert.doesNotMatch(handler, /window\.open\(/);
    assert.doesNotMatch(handler, /continuation\.externalUrl/);
    assert.match(handler, /correlationToken:continuation\.correlationToken|correlationToken: continuation\.correlationToken/);
    assert.match(handler, /Anmeldung abgeschlossen – Verbindung prüfen/);
    assert.match(handler, /Verbindung wird geprüft …/);
    assert.match(handler, /polling/);
    assert.match(handler, /errorId/);
    assert.match(handler, /MFA_REQUIRED/);
    assert.doesNotMatch(handler, /state\?\.status\s*===\s*"MFA_REQUIRED"\)\s*button\.disabled\s*=\s*true/);
    assert.match(ui, /Sie können den Vorgang sicher erneut starten/);
    assert.match(handler, /LOGIN_SUCCESSFUL/);
    assert.match(handler, /location\.reload\(\)/);
  }
});

test("tender detail exposes a server-authoritative reconnect invariant and renders its button", () => {
  const routes = fs.readFileSync(new URL("../platform/autopilot-routes.mjs", import.meta.url), "utf8");
  const ui = fs.readFileSync(new URL("../platform/assets/autopilot-navigation.js", import.meta.url), "utf8");
  assert.match(routes, /reconnect_available: reconnectAvailable/);
  assert.match(routes, /row\.session_effective_status !== "ACTIVE"/);
  assert.match(routes, /\["START_LOGIN", "CONFIRM_MFA"\]\.includes\(loginAction\.type\)/);
  assert.match(ui, /p\.reconnect_available === true/);
  assert.match(ui, /p\.reconnect_label \|\| "Erneut anmelden"/);
  assert.match(ui, /data-login-portal=/);
});

test("migration 118 adds only guarded reconnect correlation state", () => {
  const migration = fs.readFileSync(new URL("../migrations/118_correlated_portal_reconnect.sql", import.meta.url), "utf8");
  assert.match(migration, /correlation_token_hash/);
  assert.match(migration, /enrichment_version_id/);
  assert.match(migration, /blocked_action/);
  assert.match(migration, /enforce_portal_reconnect_binding/);
  assert.doesNotMatch(migration, /DELETE\s+FROM|DROP\s+TABLE/i);
});

test("operator host migration preserves historical scope and moves only verified authentication targets", () => {
  const migration = fs.readFileSync(new URL("../migrations/119_deutsche_evergabe_operator_host_migration.sql", import.meta.url), "utf8");
  assert.match(migration, /canonical_domain='bieterzugang\.deutsche-evergabe\.de'/);
  assert.match(migration, /https:\/\/portal\.deutsche-evergabe\.de\/Account\/Login/);
  assert.match(migration, /https:\/\/portal\.deutsche-evergabe\.de\/Dashboards\/Dashboard/);
  assert.match(migration, /https:\/\/portal\.deutsche-evergabe\.de\/Account\/Register/);
  assert.match(migration, /'portalIdentityChanged',false/);
  assert.match(migration, /'companyBindingChanged',false/);
  assert.match(migration, /'submissionEnabled',false/);
  assert.doesNotMatch(migration, /UPDATE\s+tender\.portal_credential|DELETE\s+FROM|DROP\s+TABLE/i);
});
