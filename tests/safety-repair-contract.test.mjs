import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizedScope } from "../platform/scoped-pg-pool.mjs";
import { readinessGate } from "../platform/product-readiness.mjs";
import { withTenantContext } from "../platform/tenant-context.mjs";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("runtime database scope rejects malformed identifiers and deduplicates bindings", () => {
  const scope = normalizedScope({ tenantIds: ["bad", "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000001"], companyIds: ["00000000-0000-4000-8000-000000000002"] });
  assert.deepEqual(scope.tenantIds, ["00000000-0000-4000-8000-000000000001"]);
  assert.deepEqual(scope.companyIds, ["00000000-0000-4000-8000-000000000002"]);
  assert(Object.isFrozen(scope));
});

test("runtime roles are non-superuser, non-bypass and backed by forced RLS", async () => {
  const sql = await source("migrations/108_tender_runtime_rls_and_integrity.sql");
  assert.match(sql, /NOSUPERUSER[\s\S]*NOBYPASSRLS/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /runtime_tenant_allowed\(tenant_id\).*runtime_company_allowed\(company_id\)/s);
  assert.match(sql, /resolve_background_scope/);
});

test("IAM binding migration provisions its non-login runtime role before grants", async () => {
  const sql = await source("migrations/087_saas_iam_binding_rls.sql");
  const createAt = sql.indexOf("CREATE ROLE saas_runtime NOLOGIN NOSUPERUSER");
  const revokeAt = sql.indexOf("REVOKE ALL ON saas.iam_subject_bindings FROM saas_runtime");
  assert(createAt >= 0);
  assert(revokeAt > createAt);
  assert.match(sql, /NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
});

test("dedicated login accounts cannot acquire administrative database attributes", async () => {
  const sql = await source("deployment/create-tender-runtime-logins.sql");
  assert.equal((sql.match(/LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/g) || []).length, 4);
  assert.match(sql, /unsafe runtime login role/);
  assert.doesNotMatch(sql, /\bSUPERUSER\b|\bBYPASSRLS\b/);
});

test("API, ingestion and queue workers install explicit background scope", async () => {
  for (const path of ["platform/server.mjs", "platform/source-ingestion.mjs", "platform/autopilot-pipeline-worker.mjs", "scripts/backfill-document-malware-scans.mjs"]) {
    const code = await source(path);
    assert.match(code, /loadBackgroundScope/);
    assert.match(code, /createFixedScopedPool/);
  }
});

test("worker writes portal sessions with exact tenant scope and only reads required IAM actor tables", async () => {
  const [worker, sql] = await Promise.all([
    source("platform/autopilot-pipeline-worker.mjs"),
    source("migrations/112_worker_runtime_scope_fixes.sql"),
  ]);
  assert.match(worker, /portal_read_sessions\(portal_id,credential_id,tenant_id,company_id/);
  assert.match(worker, /current\.tenant_id/);
  assert.match(worker, /SELECT credential\.id,scope\.tenant_id/);
  assert.doesNotMatch(worker, /SELECT credential\.id,credential\.tenant_id/);
  assert.match(worker, /service_relevance_evaluations[\s\S]*ON CONFLICT DO NOTHING/);
  assert.match(worker, /autopilot_results[\s\S]*ON CONFLICT\(tender_id,company_id,lot_key,result_version\) DO NOTHING RETURNING id/);
  assert.match(worker, /if \(!insertedResult\.rowCount\) continue/);
  assert.match(sql, /GRANT SELECT ON iam\.users,iam\.user_roles,iam\.roles,iam\.role_permissions,iam\.permissions/);
  assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE|ALL PRIVILEGES/);
});

test("database derives company tenant authoritatively and replays no submission action", async () => {
  const [worker, sql] = await Promise.all([
    source("platform/autopilot-pipeline-worker.mjs"),
    source("migrations/113_authoritative_tenant_writer_guard.sql"),
  ]);
  assert.match(worker, /calculation_input_snapshots\(\s*tenant_id,tender_id/);
  assert.match(worker, /legacy_company_tenant_bindings WHERE company_id=\$1/);
  assert.match(sql, /assign_authoritative_company_tenant/);
  assert.match(sql, /company_tenant_binding_mismatch/);
  assert.match(sql, /DLQ_RUNTIME_SCOPE_RECONCILIATION_V2/);
  assert.match(sql, /action_type NOT LIKE '%SUBMIT%'/);
});

test("malware lifecycle is persistent and every external document read is fail closed", async () => {
  const [sql, hashGuard, supersededScanGuard, statusGuard, routes] = await Promise.all([source("migrations/108_tender_runtime_rls_and_integrity.sql"), source("migrations/114_document_scan_hash_guard.sql"), source("migrations/118_superseded_scan_lifecycle_guard.sql"), source("migrations/117_document_status_writer_guard.sql"), source("platform/autopilot-routes.mjs")]);
  assert.match(sql, /document_malware_scans/);
  assert.match(sql, /CHECK\(status IN\('PENDING','CLEAN','INFECTED','SCAN_ERROR','QUARANTINED'\)\)/);
  assert.match(hashGuard, /enrichment_document_current_hash_scan_guard/);
  assert.match(hashGuard, /scan\.payload_sha256=document\.payload_sha256/);
  assert.match(hashGuard, /procurement_verification_status='REVIEW_REQUIRED'/);
  assert.match(supersededScanGuard, /SUPERSEDED_PAYLOAD_HASH/);
  assert.match(supersededScanGuard, /payload_sha256<>NEW\.payload_sha256/);
  assert.match(statusGuard, /enrichment_document_status_truth_writer_guard/);
  assert.match(statusGuard, /FETCH_OR_PARSER_FAILURE/);
  assert.match(statusGuard, /NEW\.procurement_verification_status:='REVIEW_REQUIRED'/);
  assert.match(routes, /malware_scan_status\s*!==\s*"CLEAN"/);
  const worker = await source("platform/autopilot-pipeline-worker.mjs");
  assert.match(worker, /processPendingDocumentMalwareScans/);
  assert.match(worker, /scan\.status IN\('PENDING','SCAN_ERROR','QUARANTINED'\)/);
  assert.match(worker, /next_retry_at=CASE WHEN \$4='QUARANTINED'/);
  assert.match(worker, /processPendingDocumentMalwareScans\(pool\);[\s\S]*processPendingDocumentMalwareScans\(pool\);/);
  assert.match(routes, /code\(423\)/);
});

test("package and approval truth is atomically invalidated by mutable evidence", async () => {
  const [sql, requirementTruth, writerGuard] = await Promise.all([source("migrations/108_tender_runtime_rls_and_integrity.sql"), source("migrations/115_required_document_review_classification.sql"), source("migrations/116_required_document_writer_guard.sql")]);
  assert.match(sql, /invalidate_submission_artifacts/);
  assert.match(sql, /status='SUPERSEDED'/);
  assert.match(sql, /BID_PACKAGE_READY_FOR_SUBMISSION/);
  assert.match(requirementTruth, /requirement_classification='REVIEW_REQUIRED'/);
  assert.match(requirementTruth, /satisfaction_status='MANUAL_REVIEW_REQUIRED'/);
  assert.match(requirementTruth, /'invented',false/);
  assert.match(writerGuard, /required_document_classification_writer_guard/);
  assert.match(writerGuard, /NEW\.requirement_classification:='REVIEW_REQUIRED'/);
  assert.match(writerGuard, /FAIL_CLOSED_WRITER_GUARD/);
});

test("missing DOE deadlines remain visible review evidence and are never invented", async () => {
  const [sql, server] = await Promise.all([source("migrations/109_lifecycle_queue_portal_document_truth.sql"), source("platform/server.mjs")]);
  assert.match(sql, /AUTHORITATIVE_DEADLINE_NOT_PUBLISHED/);
  assert.match(sql, /'invented',false/);
  assert.match(server, /\/api\/deadline-review/);
  assert.match(server, /NO_INVENTED_DEADLINES/);
});

test("portal jobs require exact tender-company scope and replays are idempotent", async () => {
  const [sql, worker, routes, sessionFanout] = await Promise.all([source("migrations/109_lifecycle_queue_portal_document_truth.sql"), source("platform/autopilot-pipeline-worker.mjs"), source("platform/autopilot-routes.mjs"), source("platform/verified-session-fanout.mjs")]);
  assert.match(sql, /registered_portal_scope_required_before_enqueue/);
  assert.match(sql, /repair-replay-v1:/);
  assert.match(sql, /ON CONFLICT DO NOTHING/);
  assert.match(worker, /MONITORING_CHANGE:[^\n]*registered\.portal_id/);
  assert.match(worker, /current_registered_tender_company_portals registered/);
  assert.match(sessionFanout, /current_registered_tender_company_portals registered/);
  assert.match(sessionFanout, /registered\.tender_id=relevance\.tender_id/);
  assert.match(sessionFanout, /registered\.portal_id=\$3/);
  assert.match(sessionFanout, /registered\.credential_id=\$4/);
  assert.match(routes, /PORTAL_READ_REFRESH:[^\n]*registered\.portal_id/);
  assert.match(routes, /registered\.portal_id=\$4/);
});

test("CSM core data plane, routes and forced tenant RLS ship without production seeds", async () => {
  const [sql, portal] = await Promise.all([source("migrations/110_csm_complete_data_plane.sql"), source("platform/tenant-portal.mjs")]);
  for (const noun of ["contracts", "onboarding_plans", "health_assessments", "playbooks", "report_snapshots"]) assert.match(sql, new RegExp(noun));
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  for (const route of ["customers/:id/contracts", "customers/:id/onboarding", "customers/:id/health", "playbooks", "reports"]) assert.match(portal, new RegExp(`/csm/${route}`));
  assert.doesNotMatch(sql, /INSERT INTO tenant_portal\.(customers|contracts|onboarding_plans|health_assessments)/);
});

test("portal capability aggregation uses current evidence and fails closed", async () => {
  const [sql, routes] = await Promise.all([source("migrations/109_lifecycle_queue_portal_document_truth.sql"), source("platform/autopilot-routes.mjs")]);
  assert.match(sql, /current_profiles AS/);
  assert.match(sql, /bool_and\(f\.production_tested\)/);
  assert.match(sql, /CAPABILITY_EVIDENCE_INCOMPLETE/);
  assert.match(sql, /entry_links_verified_at=NULL,entry_links_verified_by=NULL/);
  assert.equal((routes.match(/current_portal_capability_truth/g) || []).length, 7);
  assert.doesNotMatch(routes, /portal_capability_profiles[^\n]*feature_key='SUBMISSION'/);
  const gate = readinessGate({ portals: [{ portalId: "p", features: { SUBMISSION: { portalSupported: "SUPPORTED", configured: true, autopilotSupported: true, technicallyTested: false, productiveBrowserVerified: false } } }] });
  assert.equal(gate.editionReady, false);
  assert.equal(gate.status, "SAFE_FAIL_CLOSED_CAPABILITY_REVIEW_REQUIRED");
});

test("internal tenant bridge accepts the guarded request shape and scopes system reconcilers", async () => {
  const calls = [];
  const client = { query: async (text, params) => { calls.push([text, params]); return { rows: [] }; }, release() {} };
  const result = await withTenantContext({ connect: async () => client }, { id: "00000000-0000-4000-8000-000000000001", actorUserId: "00000000-0000-4000-8000-000000000002" }, async () => "ok");
  assert.equal(result, "ok");
  assert.equal(calls[1][1][0], "00000000-0000-4000-8000-000000000001");
  const [server, routes] = await Promise.all([source("platform/server.mjs"), source("platform/autopilot-routes.mjs")]);
  assert.match(server, /maintenancePool: backgroundPool/);
  assert.match(server, /internal_tenant_scope_ambiguous/);
  assert.match(routes, /maintenancePool = pool/);
});

test("expired and unscoped portal sessions cannot remain active", async () => {
  const [sql, expiry, scheduler] = await Promise.all([
    source("migrations/108_tender_runtime_rls_and_integrity.sql"),
    source("migrations/119_portal_session_expiry_materialization.sql"),
    source("platform/source-ingestion.mjs"),
  ]);
  assert.match(sql, /portal_read_session_quarantine/);
  assert.match(sql, /LEGACY_SESSION_SCOPE_UNRECOVERABLE/);
  assert.match(sql, /status='EXPIRED'/);
  assert.match(expiry, /SECURITY DEFINER/);
  assert.match(expiry, /REVOKE ALL ON FUNCTION tender\.materialize_expired_portal_sessions\(\) FROM PUBLIC/);
  assert.match(expiry, /GRANT EXECUTE ON FUNCTION tender\.materialize_expired_portal_sessions\(\) TO tender_scheduler_runtime/);
  assert.match(expiry, /WHERE status='ACTIVE' AND expires_at<=now\(\)/);
  assert.match(scheduler, /SELECT tender\.materialize_expired_portal_sessions\(\)/);
});

test("document contradictions are corrected to review instead of verified", async () => {
  const sql = await source("migrations/109_lifecycle_queue_portal_document_truth.sql");
  assert.match(sql, /procurement_verification_status='REVIEW_REQUIRED'/);
  assert.match(sql, /DOWNLOAD_FEHLGESCHLAGEN/);
  assert.match(sql, /MANUAL_REVIEW_REQUIRED/);
});

test("final preflight accepts the same explicit fail-closed review classification", async () => {
  const sql = await source("migrations/120_final_preflight_review_classification.sql");
  assert.match(sql, /final_preflight_requirements_classification_review_chk/);
  assert.match(sql, /'REVIEW_REQUIRED'/);
  assert.match(sql, /NOT VALID/);
  assert.match(sql, /VALIDATE CONSTRAINT final_preflight_requirements_classification_chk/);
});

test("lot buttons persist an exact tenant-company-tender-lot selection and restore it", async () => {
  const [sql, routes, ui] = await Promise.all([source("migrations/111_persistent_lot_selection.sql"), source("platform/autopilot-routes.mjs"), source("platform/assets/inbox-regions.js")]);
  assert.match(sql,/FORCE ROW LEVEL SECURITY/);
  assert.match(sql,/current_participation_eligible_lots/);
  assert.match(sql,/UNIQUE\(user_id,tender_id,company_id\)/);
  assert.match(routes,/LOT_SELECTION_SAVED/);
  assert.match(routes,/ON CONFLICT\(user_id,tender_id,company_id\) DO UPDATE/);
  assert.match(ui,/Los wird gespeichert/);
  assert.match(ui,/saved\.item\?\.lotKey/);
});

test("anonymous Admin bootstrap is HTTP-successful without weakening protected identity", async () => {
  const [navigation, patcher] = await Promise.all([source("integrations/wb-admin-portal/candidate/module-navigation.js"), source("deployment/admin-commercial-tenancy-patch.mjs")]);
  assert.match(navigation, /iam\/bootstrap/);
  assert.doesNotMatch(navigation, /iam\/me/);
  assert.match(patcher, /authenticated: false/);
  assert.match(patcher, /iam\/me.*preHandler: authenticate/s);
});

test("external submission remains a literal global fail-closed boundary", async () => {
  const code = await source("platform/product-readiness.mjs");
  assert.match(code, /external_submission_enabled: false/);
  assert.match(code, /bindingPortalActionsHttpStatus: 423/);
  assert.equal(readinessGate().externalSubmissionReady, false);
});

test("container healthcheck exists and scheduler health enforces all submission locks", async () => {
  const code = await source("deployment/component-healthcheck.mjs");
  assert.match(code, /127\.0\.0\.1:4240\/healthz/);
  assert.match(code, /EXTERNAL_SUBMISSION_ENABLED !== "false"/);
  assert.match(code, /WB_TENDER_ALLOW_EXTERNAL_SUBMISSION !== "false"/);
  assert.match(code, /WB_TENDER_SUBMISSION_GLOBAL_KILL_SWITCH !== "true"/);
  assert.match(code, /ready_sources !== 2/);
});

test("backup automation encrypts, verifies and constrains retention before restore", async () => {
  const [backup, restore, timer, backupRole] = await Promise.all([source("scripts/tender-encrypted-backup.sh"), source("scripts/tender-restore-verify.sh"), source("deployment/wb-tender-backup.timer"), source("deployment/create-tender-backup-login.sql")]);
  assert.match(backup,/aes-256-cbc/);
  assert.match(backup,/pg_restore --list/);
  assert.match(backup,/refusing unsafe backup roots/);
  assert.match(backup,/trap cleanup_plaintext EXIT INT TERM/);
  assert.match(backup,/dump_to_target data \/backup\/\.wb_platform\.dump/);
  assert.match(backup,/-v "\$target:\/backup:rw"/);
  assert.doesNotMatch(backup,/dump_from_container data \| openssl/);
  assert.match(restore,/--exit-on-error/);
  assert.match(restore,/rlsMissing/);
  assert.match(timer,/OnCalendar=\*-\*-\* 02:15:00 UTC/);
  assert.match(backupRole,/LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS/);
  assert.match(backupRole,/GRANT pg_read_all_data/);
  assert.match(backupRole,/default_transaction_read_only=true/);
});
