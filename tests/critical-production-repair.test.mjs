import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { classifySubmissionFailure, evaluateLiveSubmissionPrerequisites, immutableSubmissionBinding, LEGAL_CONFIRMATION_TEXT, submissionIdempotencyKey } from "../platform/submission-live-core.mjs";

const routes=fs.readFileSync(new URL("../platform/autopilot-routes.mjs",import.meta.url),"utf8");
const migration=fs.readFileSync(new URL("../migrations/160_critical_region_portal_resolution.sql",import.meta.url),"utf8");

test("region counters, filter, page and detail resolve the exact active tenant configuration while accepting only unscoped legacy rows",()=>{
  assert.match(routes,/region\.tenant_id IS NULL OR region\.tenant_id=r\.tenant_id/);
  assert.match(routes,/region\.region_profile_version_id IS NULL OR region\.region_profile_version_id=r\.active_region_version_id/);
  assert.match(routes,/region\.configuration_version_id IS NULL OR region\.configuration_version_id=r\.active_configuration_version_id/);
  assert.match(routes,/FROM category_counts CROSS JOIN filtered_count LEFT JOIN paged/);
  assert.match(routes,/source_data->>'pipelineVersion'='wb-daily-inbox-pipeline\/1\.0\.0'/);
});

test("portal resolution preserves unique legacy company credentials and separates TED publication from submission target",()=>{
  assert.match(migration,/link\.role IN\('PROCUREMENT_DOCUMENT','SUBMISSION'\)/);
  assert.match(migration,/submissionPortal','true'\)<>'false'/);
  assert.match(migration,/credential\.account_type IS NULL/);
  assert.match(migration,/HAVING count\(DISTINCT credential\.id\)=1/);
  assert.match(migration,/scope\.company_id/);
  assert.doesNotMatch(migration,/UPDATE tender\.portal_credential_(?:secrets|companies)/i);
  assert.doesNotMatch(migration,/DELETE FROM tender\.portal_credential/i);
});

test("legal submission binding is tender/company/credential specific and post-commit timeout is never retryable",()=>{
  const base={tenantId:"11111111-1111-4111-8111-111111111111",companyId:"22222222-2222-4222-8222-222222222222",tenderId:"33333333-3333-4333-8333-333333333333",lotId:"44444444-4444-4444-8444-444444444444",portalId:"55555555-5555-4555-8555-555555555555",portalAdapterId:"hermetic-double",portalAdapterVersion:"1",portalHost:"portal.invalid",portalTenderUrl:"https://portal.invalid/tender/SYNTHETIC",portalTenderReference:"SYNTHETIC-NO-SEND",lotKey:"LOT-SYNTHETIC",credentialId:"66666666-6666-4666-8666-666666666666",credentialVersion:1,bidPackageId:"77777777-7777-4777-8777-777777777777",bidPackageVersion:1,packageSha256:"a".repeat(64),approvalId:"88888888-8888-4888-8888-888888888888",deadlineVersion:"v1",deadlineEvidenceSha256:"b".repeat(64),deadlineAt:"2027-01-01T10:00:00Z",sourceTimezone:"Europe/Berlin",approvalCutoffAt:"2026-12-31T10:00:00Z",productCode:"ENTERPRISE"};
  assert.notEqual(submissionIdempotencyKey(base),submissionIdempotencyKey({...base,credentialId:"99999999-9999-4999-8999-999999999999"}));
  assert.equal(immutableSubmissionBinding(base).tenderId,base.tenderId);
  assert.ok(LEGAL_CONFIRMATION_TEXT.includes("rechtsverbindlich"));
  assert.deepEqual(classifySubmissionFailure({code:"COMMIT_TIMEOUT",phase:"COMMIT",commitStarted:true}),{state:"SUBMISSION_UNCERTAIN",retry:false,reconcile:true,code:"COMMIT_TIMEOUT"});
  const gates=Object.fromEntries(["tenderActive","procedureEligible","lotSelected","lotDeadlineExact","deadlineOpen","deadlineTimezoneVerified","amendmentsCurrent","portalResolved","portalBindingExact","adapterProductionValidated","adapterSupportsSubmission","credentialCurrent","credentialCompanyBound","portalSessionValid","portalMfaComplete","companyScopeExact","serviceScopeExact","companyProfileComplete","evidenceValid","documentsDownloaded","malwareScanPassed","analysisComplete","requirementsComplete","calculationCurrent","calculationTraceable","bidPackageImmutable","bidPackageComplete","noPlaceholders","approvalExact","fourEyesComplete","actorRoleValid","wbMfaCurrent","tenantScopeExact","rlsScopeExact","entitlementActive","globalGateEnabled","portalAllowlisted","globalKillSwitchOpen","portalKillSwitchOpen","companyKillSwitchOpen","noPriorAmbiguousAttempt","noIdenticalReceipt","approvalAfterLiveGo"].map(k=>[k,true]));
  assert.equal(evaluateLiveSubmissionPrerequisites(gates).ready,true);
});
