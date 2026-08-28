import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { containsSecret, credentialAccountEligibility, credentialJobEligibility, credentialPortalEligibility, credentialStateFingerprint, isTechnicalPublicationSource, portalCredentialJobKey, tenderCredentialPortalEligibility } from "../platform/portal-credentials.mjs";

const routes=readFileSync(new URL("../platform/autopilot-routes.mjs",import.meta.url),"utf8"),
  ui=readFileSync(new URL("../platform/assets/autopilot-navigation.js",import.meta.url),"utf8"),
  worker=readFileSync(new URL("../platform/autopilot-pipeline-worker.mjs",import.meta.url),"utf8"),
  saveRoute=routes.slice(routes.indexOf('app.post(\n    "/api/portal-access/:portalId/credentials"'),routes.indexOf('app.patch(\n    "/api/portal-access/:portalId/credential-metadata"')),
  jobRoute=routes.slice(routes.indexOf('app.post(\n    "/api/portal-access/:portalId/jobs"'),routes.indexOf('app.get(\n    "/api/management-inbox/autopilot/:tenderId/board-brief"'));

const context={credentialId:"11111111-1111-4111-8111-111111111111",version:7,portalId:"22222222-2222-4222-8222-222222222222",companyId:"33333333-3333-4333-8333-333333333333",savedAt:"2026-08-20T08:00:00.000Z"};

test("new credential state produces a safe deterministic fingerprint",()=>{
  const fingerprint=credentialStateFingerprint(context);
  assert.match(fingerprint,/^[0-9a-f]{64}$/);
  assert.equal(fingerprint,credentialStateFingerprint(context));
  assert.notEqual(fingerprint,credentialStateFingerprint({...context,version:8}));
});

test("portal login job idempotency is exact to credential id and version",()=>{
  const first=portalCredentialJobKey({actionType:"TEST_PORTAL_CONNECTION",...context,credentialVersion:7});
  assert.equal(first,portalCredentialJobKey({actionType:"TEST_PORTAL_CONNECTION",...context,credentialVersion:7}));
  assert.notEqual(first,portalCredentialJobKey({actionType:"TEST_PORTAL_CONNECTION",...context,credentialVersion:8}));
  assert.notEqual(first,portalCredentialJobKey({actionType:"TEST_PORTAL_CONNECTION",...context,credentialId:"44444444-4444-4444-8444-444444444444",credentialVersion:7}));
});

test("save response contract returns exact new state without secret material",()=>{
  for(const field of ["credentialId","credentialVersion","credentialFingerprint","companyId","portalId","savedAt","status"])assert.match(saveRoute,new RegExp(field));
  assert.doesNotMatch(saveRoute,/\.send\(\{[^}]*ciphertext|\.send\(\{[^}]*auth_tag|\.send\(\{[^}]*password/s);
});

test("save is serialized and network retries reuse the committed version",()=>{
  assert.match(saveRoute,/pg_advisory_xact_lock/);
  assert.match(saveRoute,/metadata->>'idempotencyKey'/);
  assert.match(saveRoute,/idempotent:true/);
  assert.match(ui,/pendingIdempotencyKey/);
});

test("save and verify binds the job request to the just-saved id and version",()=>{
  assert.match(ui,/form\.dataset\.credentialId=result\.credentialId/);
  assert.match(ui,/form\.dataset\.credentialVersion=result\.credentialVersion/);
  assert.match(ui,/credential_id:expectedCredentialId/);
  assert.match(ui,/credential_version:expectedCredentialVersion/);
  assert.match(jobRoute,/expectedCredentialId/);
  assert.match(jobRoute,/expectedCredentialVersion/);
});

test("a real concurrent version mismatch is the only version-conflict response",()=>{
  assert.match(jobRoute,/CREDENTIAL_VERSION_CONFLICT/);
  assert.match(jobRoute,/currentCredentialVersion:credential\.version/);
  assert.match(jobRoute,/KEIN_ADAPTER_VERFUEGBAR/);
  assert.match(jobRoute,/PORTAL_DER_AUSSCHREIBUNG_NICHT_ERMITTELT[\s\S]*?gespeicherte Portalzugang wurde nicht verändert/);
});

test("missing exact portal tender fails closed without a company fallback",()=>{
  assert.match(jobRoute,/if \(!requestedTenderRaw\)[\s\S]*PORTAL_DER_AUSSCHREIBUNG_NICHT_ERMITTELT/);
  assert.match(jobRoute,/requireParticipationEligible\(reply,requestedTender,requestedLot\)/);
  assert.doesNotMatch(jobRoute,/\bbody\.(?:lot_key|lotKey)\b/);
  assert.doesNotMatch(jobRoute,/action === "TEST_PORTAL_CONNECTION" && !requestedTender/);
  assert.doesNotMatch(jobRoute,/ORDER BY relevance\.primary_company/);
});

test("1104 or any number of same-company contexts cannot create a job",()=>{
  assert.match(jobRoute,/WHERE e\.tender_id=\$3/);
  assert.match(jobRoute,/if\(target\.length!==1\)/);
  assert.doesNotMatch(jobRoute,/LIMIT 100/);
});

test("TED is visible and may own a purpose-bound notice account, never an inferred bidder account",()=>{
  const portal={display_name:"TED – Tenders Electronic Daily",canonical_domain:"ted.europa.eu",adapter_id:"ted-discovery",adapter_enabled:true,adapter_validation_status:"PRODUCTION_VALIDATED"};
  assert.equal(isTechnicalPublicationSource(portal),false);
  assert.deepEqual(credentialPortalEligibility(portal),{eligible:true,code:null});
  assert.equal(credentialAccountEligibility(portal,"NOTICE_ACCOUNT",["NOTICE_SEARCH","SAVED_SEARCHES"]).eligible,true);
  assert.equal(credentialAccountEligibility(portal,"SUBMISSION_ACCOUNT",["BID_SUBMISSION"]).eligible,false);
  assert.equal(tenderCredentialPortalEligibility(portal).eligible,false);
  assert.equal(credentialJobEligibility(portal,{account_type:"NOTICE_ACCOUNT",authorized_capabilities:["NOTICE_SEARCH"],bound_host:"ted.europa.eu"},"TEST_PORTAL_CONNECTION").eligible,false);
  assert.match(saveRoute,/credentialPortalEligibility\(portal\)/);
  assert.match(jobRoute,/credentialJobEligibility\(portal,credential,action\)/);
});

test("DOE and OCDS API hosts are publication sources, not credential portals",()=>{
  for(const portal of [
    {canonical_domain:"oeffentlichevergabe.de",adapter_id:"doe-ocds"},
    {canonical_domain:"api.oeffentlichevergabe.de",adapter_id:"ocds-source"},
  ])assert.equal(isTechnicalPublicationSource(portal),true);
});

test("a validated external portal remains eligible",()=>{
  assert.deepEqual(credentialPortalEligibility({canonical_domain:"vergabe.example.de",adapter_id:"example-adapter",adapter_enabled:true,adapter_validation_status:"PRODUCTION_VALIDATED"}),{eligible:true,code:null});
});

test("job binding requires tender company portal and exact credential together",()=>{
  assert.match(jobRoute,/current_tender_company_portal_role_scopes registered/);
  assert.match(jobRoute,/registered\.source_lot_id=nullif\(\$8,''\)/);
  assert.match(jobRoute,/registered\.portal_id=\$6 AND registered\.credential_id=\$7/);
  assert.match(ui,/credential_id:expectedCredentialId/);
  assert.match(ui,/credential_version:expectedCredentialVersion/);
});

test("wrong portal host cannot satisfy exact tender evidence",()=>{
  assert.match(jobRoute,/lower\(split_part\(split_part\(d\.source_url,'\:\/\/',2\),'\/',1\)\)=ANY\(\$1::text\[\]\)/);
  assert.match(jobRoute,/d\.provenance->>'portalId'=\$2/);
});

test("worker revalidates exact registered tender binding and adapter",()=>{
  assert.match(worker,/current_tender_company_portal_role_scopes scope/);
  assert.match(worker,/scope\.source_lot_id=\$5/);
  assert.match(worker,/job adapter does not match exact portal binding/);
  assert.doesNotMatch(worker,/const isPortalConnectionTest/);
});

test("tender context keeps TED visible while directing bidder actions to portal search",()=>{
  assert.match(ui,/TED ist hier als Bekanntmachungsdienst sichtbar/);
  assert.match(ui,/Tatsächliches Vergabeportal suchen und auswählen/);
  assert.match(ui,/locked&&portal\.tenderPortalSelectable===false/);
});

test("double click is disabled and one user action has one idempotency key",()=>{
  assert.match(ui,/form\.dataset\.saving==="true"/);
  assert.match(ui,/buttons\.forEach\(button=>button\.disabled=true\)/);
  assert.match(ui,/crypto\.randomUUID\(\)/);
});

test("save success and job-start failure remain distinct in the UI",()=>{
  assert.match(ui,/Zugang sicher gespeichert · Credential-Version/);
  assert.match(ui,/Der Portalzugang wurde sicher gespeichert\. Die Anmeldeprüfung konnte noch nicht gestartet werden\./);
});

test("stored-access check resolves current state server-side",()=>{
  assert.match(jobRoute,/activeCredentialForCompany\(portal\.id, company\.company_id\)/);
  assert.match(ui,/expectedCredentialId=String\(form\.dataset\.credentialId\|\|""\)/);
});

test("older jobs cannot persist session or success for a replaced credential",()=>{
  assert.match(worker,/credential version superseded before session persistence/);
  assert.match(worker,/credential version superseded before session refresh/);
  assert.match(worker,/credential version superseded before status persistence/);
  assert.match(worker,/SELECT id FROM tender\.portal_registry WHERE id=\$1 FOR UPDATE/);
});

test("API, UI and browser storage exclude secret material",()=>{
  const publicShape={credentialId:context.credentialId,credentialVersion:7,credentialFingerprint:credentialStateFingerprint(context),companyId:context.companyId,portalId:context.portalId,status:"SAVED"};
  assert.equal(containsSecret(publicShape,["clear-password","cipher-value","totp-seed"]),false);
  assert.doesNotMatch(ui,/localStorage\.setItem\([^\n]*(?:password|username|ciphertext|totp|recovery)/i);
  assert.doesNotMatch(saveRoute,/JSON\.stringify\(\{[^}]*password|JSON\.stringify\(\{[^}]*ciphertext/s);
});
