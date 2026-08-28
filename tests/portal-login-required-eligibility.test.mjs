import test from "node:test";
import assert from "node:assert/strict";
import { credentialPortalEligibility } from "../platform/portal-credentials.mjs";

const base={canonical_domain:"bieterzugang.deutsche-evergabe.de",adapter_id:"deutsche-evergabe",adapter_enabled:true,adapter_validation_status:"LOGIN_REQUIRED",authentication_entry_url:"https://bieterzugang.deutsche-evergabe.de/evergabe.bieter/login.aspx",last_verified_at:"2026-08-21T19:46:11.592Z"};

test("verified LOGIN_REQUIRED portal remains eligible for the login connector",()=>{
  assert.deepEqual(credentialPortalEligibility(base),{eligible:true,code:null,loginValidationPending:true});
});

test("LOGIN_REQUIRED without an administratively verified login target fails closed",()=>{
  assert.equal(credentialPortalEligibility({...base,authentication_entry_url:null}).eligible,false);
  assert.equal(credentialPortalEligibility({...base,last_verified_at:null}).eligible,false);
});

test("login eligibility does not promote portal submission validation",()=>{
  const decision=credentialPortalEligibility(base);
  assert.equal(decision.loginValidationPending,true);
  assert.notEqual(base.adapter_validation_status,"PRODUCTION_VALIDATED");
});
