import assert from "node:assert/strict";
import test from "node:test";
import {runSyntheticE2EMatrix,SYNTHETIC_E2E_COMPANY_TYPES,SYNTHETIC_E2E_PORTAL_FAMILIES} from "../platform/synthetic-e2e-harness.mjs";

test("six synthetic company types complete all 25 non-binding steps on all 16 relevant portal families and clean up exactly",{timeout:120_000},async()=>{
  const report=await runSyntheticE2EMatrix({runId:"automated-contract-test",now:new Date("2026-08-26T13:00:00.000Z")});
  assert.equal(report.status,"INTERNALLY_SIMULATED_ONLY");
  assert.equal(report.coverage.companyTypes,SYNTHETIC_E2E_COMPANY_TYPES.length);
  assert.equal(report.coverage.portalFamilies,SYNTHETIC_E2E_PORTAL_FAMILIES.length);
  assert.equal(report.coverage.scenarios,96);
  assert.equal(report.coverage.totalStepAssertions,2400);
  assert.equal(report.coverage.credentialStatuses,10);
  assert.equal(report.coverage.contextStateAssertions,1632);
  assert.equal(report.inventory.beforeCleanup.credentials,96);
  assert.equal(report.inventory.beforeCleanup.sessions,96);
  assert.equal(report.inventory.beforeCleanup.tenders,96);
  assert.equal(report.inventory.beforeCleanup.documents,288);
  assert.equal(report.inventory.beforeCleanup.packages,96);
  assert.equal(report.inventory.beforeCleanup.receipts,96);
  assert.equal(report.inventory.beforeCleanup.queues,96);
  assert.equal(report.inventory.exactCleanupMatch,true);
  assert.equal(report.security.networkAttempts,0);
  assert.equal(report.security.transmittedTrueBeforeCleanup,0);
  assert.equal(report.security.transmittedTrueAfterCleanup,0);
  assert.equal(report.security.realDataChanged,false);
  assert.equal(report.resultLabels.INTERNALLY_SIMULATED_ONLY,true);
  assert.equal(report.resultLabels.EXTERNAL_VALIDATION_PENDING,true);
  assert.equal(report.scenarios.every(item=>item.cleanupStatus==="CLEANED"&&item.transmitted===false),true);
});
