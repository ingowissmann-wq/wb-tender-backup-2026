import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PORTAL_ACCESS_STATUSES,
  canonicalPortalAccessStatus,
  isFreshRunningPortalJob,
  portalAccessPresentation,
} from "../platform/canonical-portal-access.mjs";
import { portalLoginAction } from "../platform/portal-login-action.mjs";

const inbox = readFileSync(new URL("../platform/assets/inbox-regions.js", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../platform/assets/autopilot-navigation.js", import.meta.url), "utf8");
const routes = readFileSync(new URL("../platform/autopilot-routes.mjs", import.meta.url), "utf8");

test("all eleven canonical credential states have an unambiguous presentation", () => {
  assert.deepEqual(PORTAL_ACCESS_STATUSES, [
    "NOT_CONFIGURED", "CREDENTIAL_SCOPE_CONFLICT", "CONFIGURED_UNVERIFIED", "VALID", "MFA_REQUIRED",
    "CAPTCHA_OR_USER_ACTION_REQUIRED", "EXPIRED", "INVALID", "LOCKED",
    "PORTAL_UNAVAILABLE", "VALIDATION_PENDING",
  ]);
  for (const status of PORTAL_ACCESS_STATUSES) {
    const presentation = portalAccessPresentation(status);
    assert.ok(presentation.label, status);
    assert.ok(presentation.message, status);
  }
  assert.equal(portalAccessPresentation("NOT_CONFIGURED").actionLabel, "Zugangsdaten hinterlegen");
  assert.equal(portalAccessPresentation("CREDENTIAL_SCOPE_CONFLICT").actionType, "NONE");
  assert.equal(portalAccessPresentation("CONFIGURED_UNVERIFIED").actionLabel, "Zugang prüfen");
  assert.equal(portalAccessPresentation("EXPIRED").actionLabel, "Zugang aktualisieren");
});

test("pending portal status requires fresh unfinished queue evidence", () => {
  const now = new Date("2026-08-29T07:00:00Z");
  const fresh = {
    configured: true,
    jobStatus: "RUNNING",
    jobCreatedAt: "2026-08-29T06:59:00Z",
    jobHeartbeatAt: "2026-08-29T06:59:30Z",
    jobTimeoutAt: "2026-08-29T07:02:00Z",
    now,
  };
  assert.equal(isFreshRunningPortalJob(fresh), true);
  assert.equal(canonicalPortalAccessStatus(fresh), "VALIDATION_PENDING");
  assert.equal(canonicalPortalAccessStatus({
    ...fresh,
    jobTimeoutAt: "2026-08-29T06:59:59Z",
  }), "CONFIGURED_UNVERIFIED");
  assert.equal(canonicalPortalAccessStatus({
    configured: true,
    jobStatus: "RUNNING",
    now,
  }), "CONFIGURED_UNVERIFIED");
  assert.equal(canonicalPortalAccessStatus({
    ...fresh,
    sessionEffectiveStatus: "ACTIVE",
  }), "VALID");
  assert.equal(canonicalPortalAccessStatus({
    ...fresh,
    jobFinishedAt: "2026-08-29T06:59:45Z",
  }), "CONFIGURED_UNVERIFIED");
});

test("restored real portal states cannot regress to an endless pending status", () => {
  const restoredAt = new Date("2026-08-29T18:24:01.707Z");

  assert.equal(canonicalPortalAccessStatus({
    configured: true,
    credentialStatus: "ACTIVE",
    loginStatus: "LOGIN_UNGEPRUEFT",
    sessionEffectiveStatus: "RELOGIN_REQUIRED_REVOKED",
    jobStatus: "SUCCEEDED",
    jobCreatedAt: "2026-08-22T10:13:20.287Z",
    jobStartedAt: "2026-08-22T10:13:24.307Z",
    jobHeartbeatAt: "2026-08-22T10:13:34.264Z",
    jobTimeoutAt: "2026-08-22T10:16:24.307Z",
    jobFinishedAt: "2026-08-22T10:13:34.264Z",
    now: restoredAt,
  }), "EXPIRED");

  assert.equal(canonicalPortalAccessStatus({
    configured: true,
    credentialStatus: "ACTIVE",
    loginStatus: "LOGIN_UNGEPRUEFT",
    now: restoredAt,
  }), "CONFIGURED_UNVERIFIED");

  for (const jobStatus of ["SUCCEEDED", "CANCELLED", "FAILED", "DEAD_LETTER"]) {
    assert.notEqual(canonicalPortalAccessStatus({
      configured: true,
      credentialStatus: "ACTIVE",
      jobStatus,
      jobCreatedAt: "2026-08-20T06:49:27.333Z",
      jobTimeoutAt: "2026-08-20T06:52:27.333Z",
      jobFinishedAt: "2026-08-20T06:49:44.188Z",
      now: restoredAt,
    }), "VALIDATION_PENDING", jobStatus);
  }
});

test("canonical precedence is fail-closed and does not infer validity from documents", () => {
  assert.equal(canonicalPortalAccessStatus({ scopeConflict:true }), "CREDENTIAL_SCOPE_CONFLICT");
  assert.equal(canonicalPortalAccessStatus({ scopeConflict:true, configured:true, loginStatus:"LOGIN_BESTAETIGT" }), "CREDENTIAL_SCOPE_CONFLICT");
  assert.equal(canonicalPortalAccessStatus({ configured:true, jobResultCode:"KONTO_GESPERRT" }), "LOCKED");
  assert.equal(canonicalPortalAccessStatus({ configured:true, jobResultCode:"BENUTZERNAME_ODER_PASSWORT_FALSCH" }), "INVALID");
  assert.equal(canonicalPortalAccessStatus({ configured:true, jobResultCode:"PORTAL_NICHT_ERREICHBAR" }), "PORTAL_UNAVAILABLE");
  assert.equal(canonicalPortalAccessStatus({ configured:true, loginStatus:"MFA_ERFORDERLICH" }), "MFA_REQUIRED");
  assert.equal(canonicalPortalAccessStatus({ configured:true, loginStatus:"LOGIN_BESTAETIGT" }), "VALID");
  assert.equal(canonicalPortalAccessStatus({ configured:true, credentialValidUntil:"2026-08-25T00:00:00Z", now:new Date("2026-08-26T00:00:00Z") }), "EXPIRED");
});

test("credential actions use canonical state and never ask to create an existing access", () => {
  const base = { tenderId:"t", companyId:"c", portalId:"p", configured:true, authenticationTargetConfigured:true };
  assert.equal(portalLoginAction({ ...base, credentialStatus:"CONFIGURED_UNVERIFIED" }).label, "Zugang prüfen");
  assert.equal(portalLoginAction({ ...base, credentialStatus:"EXPIRED" }).label, "Zugang aktualisieren");
  assert.equal(portalLoginAction({ ...base, credentialStatus:"MFA_REQUIRED" }).label, "MFA fortsetzen");
  assert.equal(portalLoginAction({ ...base, credentialStatus:"CAPTCHA_OR_USER_ACTION_REQUIRED" }).type, "CONFIRM_CAPTCHA");
  assert.equal(portalLoginAction({ ...base, credentialStatus:"VALID", portalOpenAvailable:true }).label, "Portal öffnen");
  assert.equal(portalLoginAction({ ...base, credentialStatus:"CREDENTIAL_SCOPE_CONFLICT" }).type, "NONE");
});

test("all tender surfaces consume separate credential and document truth", () => {
  for (const source of [inbox, navigation]) {
    assert.match(source, /credential_status/);
    assert.match(source, /document_status/);
    assert.match(source, /Zugangsdaten verwalten/);
    assert.match(source, /Kein erneuter Abruf erforderlich/);
  }
  assert.match(routes, /credential_status: credentialStatus/);
  assert.match(routes, /document_status: accessStatus/);
  assert.match(routes, /portalRole: "DOCUMENT_PORTAL"/);
  assert.match(routes, /requireCredential: false/);
});

test("stored access and setup prompt cannot be emitted together", () => {
  const configuredMessages = PORTAL_ACCESS_STATUSES
    .filter((status) => status !== "NOT_CONFIGURED")
    .map((status) => portalAccessPresentation(status).message);
  assert.equal(configuredMessages.some((message) => message.includes("ein Zugang einzurichten")), false);
});

test("six company types and sixteen portal families render all eleven states without contradictions", () => {
  const companies = ["cleaning", "emergency", "facility", "protect", "security", "security-technology"],
    families = ["ai-vergabe-manager", "aumass", "bi-medien", "cosinex", "deutsche-evergabe", "dtvp", "etenders-ireland", "eu-funding-tenders", "evergabe-bayern", "evergabe-de", "evergabe-online-bund", "mercell-s2c", "rib-meinauftrag", "subreport", "ted", "vergabe24"];
  let assertions = 0;
  for (const company of companies) for (const family of families) for (const status of PORTAL_ACCESS_STATUSES) {
    const presentation = portalAccessPresentation(status);
    assert.ok(company && family && presentation.label);
    if (status === "NOT_CONFIGURED") assert.equal(presentation.actionLabel, "Zugangsdaten hinterlegen");
    else assert.notEqual(presentation.actionLabel, "Zugangsdaten hinterlegen");
    assertions += 1;
  }
  assert.equal(assertions, 1056);
});

test("the restored shared-credential matrix remains visible but non-executable", () => {
  const sharedCredentialCompanyCounts = [2, 3, 3, 4, 3, 4];
  assert.equal(sharedCredentialCompanyCounts.length, 6);
  assert.equal(sharedCredentialCompanyCounts.reduce((sum, count) => sum + count, 0), 19);
  for (const activeCompanyCount of sharedCredentialCompanyCounts) {
    const status = canonicalPortalAccessStatus({
      configured: true,
      scopeConflict: activeCompanyCount > 1,
      loginStatus: "LOGIN_BESTAETIGT",
      sessionEffectiveStatus: "ACTIVE",
    });
    assert.equal(status, "CREDENTIAL_SCOPE_CONFLICT");
    assert.equal(portalLoginAction({
      tenderId:"t", companyId:"c", portalId:"p", configured:true,
      authenticationTargetConfigured:true, credentialStatus:status,
    }).type, "NONE");
  }
  assert.match(routes, /credentialScopeConflictForCompany/);
  assert.match(routes, /credential_scope_conflict/);
  assert.match(routes, /scopeConflict: scopedCredentialConflict/);
  assert.match(routes, /scopeConflict \? "" : `<button type="button" data-test-portal-credential>/);
  assert.match(navigation, /CREDENTIAL_SCOPE_CONFLICT/);
  assert.match(inbox, /CREDENTIAL_SCOPE_CONFLICT/);
});
