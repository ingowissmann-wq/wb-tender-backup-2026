import { readFile } from "node:fs/promises";
import pg from "pg";

const { Pool } = pg;
if (String(process.env.EXTERNAL_SUBMISSION_ENABLED).toLowerCase() !== "false") {
  throw new Error("external_submission_must_be_disabled");
}

const routes = await readFile(new URL("../platform/autopilot-routes.mjs", import.meta.url), "utf8");
if (!/reply\.code\(423\)/.test(routes) || !/external_submission_disabled/.test(routes)) {
  throw new Error("http_423_gate_missing");
}

const readSecret = async (name) => {
  const inline = process.env[name];
  if (inline) return inline;
  const file = process.env[`${name}_FILE`];
  if (!file) throw new Error(`${name.toLowerCase()}_source_missing`);
  const value = (await readFile(file, "utf8")).trim();
  if (!value) throw new Error(`${name.toLowerCase()}_source_empty`);
  return value;
};

const pool = new Pool({ connectionString: await readSecret("DATABASE_URL"), max: 2 });
try {
  const constraints = await pool.query(`
    SELECT conname, convalidated
    FROM pg_constraint
    WHERE conname = ANY($1::text[])
    ORDER BY conname
  `, [[
    "autopilot_queue_status_check",
    "calculations_status_check",
    "generated_documents_internal_draft_only_chk",
  ]]);
  if (constraints.rows.length !== 3 || constraints.rows.some((row) => !row.convalidated)) {
    throw new Error("required_constraints_not_validated");
  }

  const safety = (await pool.query(`
    SELECT
      (SELECT count(*)::int FROM tender.external_action_receipts) external_receipts,
      (SELECT count(*)::int FROM tender.submission_receipts) submission_receipts,
      (SELECT count(*)::int FROM tender.autopilot_queue
       WHERE status IN ('CLAIMED','RUNNING')
         AND coalesce(last_progress_at, heartbeat_at, started_at, claimed_at, created_at)
             < now() - interval '15 minutes') stale_jobs,
      (SELECT count(*)::int
       FROM tender.portal_read_sessions session
       JOIN tender.portal_credential_secrets credential ON credential.id=session.credential_id
       WHERE session.status='ACTIVE' AND session.portal_id IS DISTINCT FROM credential.portal_id) active_scope_mismatches
  `)).rows[0];
  if (safety.external_receipts || safety.submission_receipts) throw new Error("external_transmission_receipt_present");
  if (safety.stale_jobs) throw new Error("stale_autopilot_jobs_present");
  if (safety.active_scope_mismatches) throw new Error("active_portal_scope_mismatch");

  const health = await fetch("http://127.0.0.1:4240/healthz");
  if (!health.ok) throw new Error(`api_health_failed_${health.status}`);

  console.log(JSON.stringify({
    passed: true,
    apiHealth: health.status,
    constraintsValidated: 3,
    externalSubmissionEnabled: false,
    externalReceipts: safety.external_receipts,
    submissionReceipts: safety.submission_receipts,
    staleJobs: safety.stale_jobs,
    activeScopeMismatches: safety.active_scope_mismatches,
  }));
} finally {
  await pool.end();
}
