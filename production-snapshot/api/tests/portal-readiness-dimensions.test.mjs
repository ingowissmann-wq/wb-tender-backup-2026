import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {COMPANY_CONFIGURATION_CAPABILITIES,FAMILY_ADAPTER_CAPABILITIES,INTERNAL_PLATFORM_CAPABILITIES,
  observedPortalFamily,portalOperationalRelevance,familyAdapterMaturity} from "../platform/portal-readiness-dimensions.mjs";

test("company configuration, family adapter and internal platform readiness are disjoint dimensions",()=>{
  assert.equal(new Set([...COMPANY_CONFIGURATION_CAPABILITIES,...FAMILY_ADAPTER_CAPABILITIES,...INTERNAL_PLATFORM_CAPABILITIES]).size,
    COMPANY_CONFIGURATION_CAPABILITIES.length+FAMILY_ADAPTER_CAPABILITIES.length+INTERNAL_PLATFORM_CAPABILITIES.length);
  assert.ok(COMPANY_CONFIGURATION_CAPABILITIES.includes("CREDENTIAL_STORE"));
  assert.ok(FAMILY_ADAPTER_CAPABILITIES.includes("BINDING_SUBMIT"));
  assert.ok(INTERNAL_PLATFORM_CAPABILITIES.includes("RLS_TENANT_ISOLATION"));
});

test("observed software paths consolidate host rows without inventing a company adapter",()=>{
  assert.equal(observedPortalFamily({adapterId:"unknown-x",domain:"one.example",sampleUrl:"https://one.example/VMPSatellite/notice/CX1"}).familyKey,"cosinex");
  assert.equal(observedPortalFamily({adapterId:"unknown-y",domain:"two.example",sampleUrl:"https://two.example/NetServer/"}).familyKey,"ai-vergabe-manager");
  assert.equal(observedPortalFamily({adapterId:"cosinex-vmp-public",domain:"three.example"}).familyKey,"cosinex");
  assert.match(observedPortalFamily({adapterId:"unknown-z",domain:"unresolved.example"}).familyKey,/^unresolved:/);
});

test("portal relevance uses observed production criteria and adapter maturity does not confuse simulations with implementation",()=>{
  assert.deepEqual(portalOperationalRelevance({activeOfficialLinks:1}).relevant,true);
  assert.deepEqual(portalOperationalRelevance({}).relevant,false);
  assert.equal(familyAdapterMaturity({familyKey:"cosinex",readCapabilitiesComplete:true,
    submissionProtocolImplemented:false,mockReplayContractPassed:true}).status,"ADAPTER_IMPLEMENTATION_REQUIRED");
  assert.equal(familyAdapterMaturity({familyKey:"cosinex",readCapabilitiesComplete:true,
    submissionProtocolImplemented:true,mockReplayContractPassed:true}).status,"INTERNALLY_READY");
});

test("legacy cartesian gaps are consolidated into internal, external and inactive causes",()=>{
  const inventory=fs.readFileSync(new URL("../scripts/portal-readiness-deduplicated-inventory-readonly.mjs",import.meta.url),"utf8");
  assert.match(inventory,/LEGACY_CARTESIAN_EVALUATIONS_NOT_DISTINCT_ADAPTER_IMPLEMENTATIONS/);
  assert.match(inventory,/EXTERNAL_VALIDATION_PENDING/);
  assert.match(inventory,/INTERNAL_CONTRACT_TEST_REPAIR_REQUIRED/);
  assert.match(inventory,/ADAPTER_IMPLEMENTATION_REQUIRED/);
  assert.match(inventory,/INACTIVE_HISTORICAL_OR_THEORETICAL/);
  assert.match(inventory,/internallyUnsupportedEvaluations/);
});
