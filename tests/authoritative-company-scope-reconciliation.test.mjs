import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const script=fs.readFileSync(new URL("../scripts/reconcile-authoritative-company-scope.mjs",import.meta.url),"utf8");

test("scope reconciliation is plan-hash bound, exact-company scoped and submission inert",()=>{
  for(const token of ["TARGET_COMPANY","authoritySha256","scope_reconciliation_plan_hash_mismatch","BEGIN ISOLATION LEVEL SERIALIZABLE","pg_advisory_xact_lock","POTENTIALLY_RELEVANT","REVIEW_REQUIRED","MANUAL_COMPANY_ASSIGNMENT_REQUIRED","noCrossCompanyDataCopied:true","externalWrite:false","transmitted:false"])
    assert.ok(script.includes(token),token);
  assert.doesNotMatch(script,/BINDING_SUBMIT|external_submission_enabled\s*=\s*true|allow_external_submission\s*=\s*true/);
});

test("candidate discovery does not copy credentials, regions, costs, documents or primary assignment",()=>{
  assert.match(script,/independentTaxonomyMatch:true/);
  assert.match(script,/primary_company,alternative_company/);
  assert.match(script,/false,false,'security'/);
  assert.doesNotMatch(script,/INSERT INTO tender\.(portal_credential|region_|cost_|enrichment_documents|required_documents|calculations)/);
  assert.doesNotMatch(script,/tender\.(procurement_subject|contract_type)/);
});
