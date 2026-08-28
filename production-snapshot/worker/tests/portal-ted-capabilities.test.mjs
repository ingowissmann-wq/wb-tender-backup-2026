import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {
  TED_SERVICE_CATALOG,
  credentialAccountEligibility,
  credentialJobEligibility,
  isTedHost,
  portalCatalogProfile,
  tenderPortalEligibility,
  withTedServiceCatalog,
} from "../platform/portal-capability-policy.mjs";
import {searchPortalResults} from "../platform/portal-management-search.mjs";

const ui=readFileSync(new URL("../platform/assets/autopilot-navigation.js",import.meta.url),"utf8"),
  migration=readFileSync(new URL("../migrations/103_portal_credential_capability_scope.sql",import.meta.url),"utf8");

const ted={id:"3c8a6c78-ca63-4a13-843d-e06a1a73a379",display_name:"TED – Tenders Electronic Daily",canonical_domain:"ted.europa.eu",adapter_id:"ted-discovery",adapter_enabled:true,adapter_validation_status:"PRODUCTION_VALIDATED",capabilities:[]};

test("TED search and unfiltered catalog retain all documented services",()=>{
  const catalog=withTedServiceCatalog([ted]);
  assert.equal(catalog.filter((row)=>isTedHost(row)).length,TED_SERVICE_CATALOG.length);
  const items=catalog.map((row)=>{const p=row.catalog_profile;return {portalName:p.officialName,operator:p.operator,domain:p.host,purpose:p.purpose,serviceCapabilities:p.capabilities,serviceRoles:p.roles,isTedService:p.isTedService,access:{configured:false}}});
  assert.ok(searchPortalResults(items,{q:"TED"}).total>=1);
  assert.equal(searchPortalResults(items,{q:"ted.europa.eu"}).total,TED_SERVICE_CATALOG.length);
  assert.equal(searchPortalResults(items,{portalRole:"ted"}).total,TED_SERVICE_CATALOG.length);
});

test("TED subdomains are exact-host classified and unknown hosts remain visible for review",()=>{
  const known=portalCatalogProfile({canonical_domain:"enotices2.ted.europa.eu"});
  assert.ok(known.capabilities.includes("NOTICE_PUBLICATION"));
  assert.ok(known.roles.includes("BUYER"));
  const unknown=portalCatalogProfile({canonical_domain:"future-service.ted.europa.eu"});
  assert.equal(unknown.isTedService,true);
  assert.equal(unknown.knownTedService,false);
  assert.equal(unknown.validationStatus,"REVIEW_REQUIRED");
  assert.equal(tenderPortalEligibility({canonical_domain:"future-service.ted.europa.eu"}).code,"PORTAL_NICHT_VALIDIERT");
  assert.equal(isTedHost("not-ted.europa.example"),false);
});

test("notice account is host/capability bound and cannot perform bidder jobs",()=>{
  const decision=credentialAccountEligibility(ted,"NOTICE_ACCOUNT",["NOTICE_SEARCH","ALERTS"]);
  assert.deepEqual(decision,{eligible:true,code:null,accountType:"NOTICE_ACCOUNT",capabilities:["NOTICE_SEARCH","ALERTS"],boundHost:"ted.europa.eu"});
  const credential={account_type:"NOTICE_ACCOUNT",authorized_capabilities:decision.capabilities,bound_host:decision.boundHost};
  assert.equal(credentialJobEligibility(ted,credential,"TEST_PORTAL_CONNECTION").eligible,false);
  assert.equal(credentialJobEligibility({...ted,canonical_domain:"other.example"},credential,"TEST_PORTAL_CONNECTION").eligible,false);
});

test("TED has no bid-submission capability unless the exact service is separately validated",()=>{
  for(const service of TED_SERVICE_CATALOG)assert.equal(service.capabilities.includes("BID_SUBMISSION"),false,service.host);
  assert.equal(tenderPortalEligibility(ted).code,"PORTAL_DER_AUSSCHREIBUNG_NICHT_ERMITTELT");
});

test("UI exposes role filters, TED actions and the tender warning",()=>{
  for(const value of ["Alle Portale","Veröffentlichungsportale","Bekanntmachungsportale","Dokumentportale","Loginportale","Abgabeportale","TED-Dienste","TED öffnen","Bekanntmachungen suchen","Das tatsächliche Vergabe- und Abgabeportal dieser Ausschreibung kann von TED abweichen."])
    assert.match(ui,new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
});

test("migration is additive and typed notice accounts are excluded from tender action scope",()=>{
  assert.match(migration,/ADD COLUMN IF NOT EXISTS account_type/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS authorized_capabilities/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS bound_host/);
  assert.match(migration,/'BID_SUBMISSION'=ANY/);
  assert.match(migration,/current_tender_company_portal_credential_scopes/);
  assert.match(migration,/credential\.authorized_capabilities && ARRAY\[/);
  assert.doesNotMatch(migration,/DELETE FROM|TRUNCATE|DROP TABLE/i);
});
