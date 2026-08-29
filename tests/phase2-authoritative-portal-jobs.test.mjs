import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migration = fs.readFileSync(new URL("../migrations/153_phase2_authoritative_portal_jobs.sql", import.meta.url), "utf8");
const down = fs.readFileSync(new URL("../migrations/153_phase2_authoritative_portal_jobs.down.sql", import.meta.url), "utf8");
const companyScopeMigration = fs.readFileSync(new URL("../migrations/154_phase2_company_scoped_resolver_jobs.sql", import.meta.url), "utf8");
const worker = fs.readFileSync(new URL("../platform/autopilot-pipeline-worker.mjs", import.meta.url), "utf8");
const ingestion = fs.readFileSync(new URL("../platform/source-ingestion.mjs", import.meta.url), "utf8");

test("notice resolution queue scope is current-version, credentialless and submission inert", () => {
  assert.match(migration, /action_type='RESOLVE_NOTICE_PORTALS'/);
  assert.match(migration, /'RESOLVE_NOTICE_PORTALS'\s*\n?\s*\)\) NOT VALID/);
  assert.match(companyScopeMigration, /NEW\.company_id IS NOT NULL AND NEW\.lot_key IS NULL AND NEW\.portal_id IS NULL AND NEW\.credential_id IS NULL/);
  assert.match(companyScopeMigration, /relevance\.company_id=NEW\.company_id/);
  assert.match(migration, /current_version\.tender_id=NEW\.tender_id/);
  assert.doesNotMatch(migration, /EXTERNAL_SUBMISSION_ENABLED\s*=\s*true|WB_TENDER_ALLOW_EXTERNAL_SUBMISSION\s*=\s*true/);
});

test("document continuation requires exact role, company, lot, portal and credential or validated public evidence", () => {
  for (const contract of [
    /current_tender_company_portal_role_scopes/,
    /scope\.source_lot_id=NEW\.lot_key/,
    /scope\.portal_role='DOCUMENT_PORTAL'/,
    /scope\.credential_id=NEW\.credential_id/,
    /portal\.adapter_validation_status='PRODUCTION_VALIDATED'/,
    /link\.public_access=true/,
  ]) assert.match(migration, contract);
});

test("credential projection retains single-company legacy access and excludes shared or typed mismatches", () => {
  assert.match(migration, /credential\.account_type IS NULL OR/);
  assert.match(migration, /other_scope\.company_id<>assignment\.company_id/);
  assert.match(migration, /credential\.bound_host=lower\(assignment\.exact_host\)/);
  assert.match(migration, /count\(DISTINCT credential\.id\)=1/);
});

test("continuous imports enqueue resolution and worker persists roles before download continuation", () => {
  assert.match(ingestion, /'RESOLVE_NOTICE_PORTALS'/);
  assert.match(ingestion, /relevance\.company_id/);
  assert.match(worker, /String\(item\.company_id/);
  assert.match(worker, /scope\.credential_id IS NOT NULL OR EXISTS/);
  assert.match(worker, /PORTAL_CONTINUATION_SCOPE_REJECTED/);
  assert.match(worker, /set_config\('tender\.pipeline_job_id',\$19,true\)/);
  assert.match(worker, /suppressPipelineEnqueue: true/);
  assert.match(worker, /exactDocumentAssignments\.length !== 1/);
  assert.match(worker, /scope\.portal_role='DOCUMENT_PORTAL'/);
  assert.match(worker, /\["SESSION_NICHT_FUER_DOWNLOAD_GUELTIG", "REAUTH_REQUIRED"\]/);
  assert.match(worker, /allowRecentVerifiedSessionReuse === true/);
  assert.match(worker, /Date\.now\(\) - 120_000/);
  assert.match(worker, /now\(\)-interval '6 hours'/);
  assert.match(worker, /ORDER BY id LIMIT \$4 FOR UPDATE/);
  assert.match(worker, /persistAuthoritativePortalEvidence/);
  assert.match(worker, /materializeAuthoritativePortalAssignments/);
  assert.match(worker, /'FETCH_DOCUMENTS'/);
});

test("rollback restores the 152.2 guard and preserves business rows", () => {
  assert.match(down, /current_registered_tender_company_portals/);
  assert.doesNotMatch(down, /DELETE FROM tender\.|TRUNCATE|DROP TABLE/i);
});
