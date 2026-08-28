import { readFileSync } from "node:fs";
import pg from "pg";
import { canonicalJson, sha256 } from "../platform/lifecycle-plan.mjs";

const apply = process.argv.includes("--apply"), runId = process.env.NOTICE_LIFECYCLE_CORRECTION_RUN_ID || "", expectedPlan = process.env.EXPECTED_PLAN_SHA256 || "";
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) throw new Error("valid NOTICE_LIFECYCLE_CORRECTION_RUN_ID is required");
if (!/^[0-9a-f]{64}$/.test(expectedPlan)) throw new Error("valid EXPECTED_PLAN_SHA256 is required");
if (apply && process.env.NOTICE_LIFECYCLE_ROLLBACK_APPROVED !== "true") throw new Error("NOTICE_LIFECYCLE_ROLLBACK_APPROVED=true is required");
const connectionString = process.env.DATABASE_URL || readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim();
const pool = new pg.Pool({ connectionString, max: 1 }), client = await pool.connect();
try {
  await client.query(apply ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
  if (apply) await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30min'");
  const run = (await client.query(`SELECT * FROM tender.notice_lifecycle_correction_runs WHERE run_id=$1${apply ? " FOR UPDATE" : ""}`, [runId])).rows[0];
  if (!run || run.plan_sha256 !== expectedPlan) throw new Error("correction run or plan hash mismatch");
  if (sha256(canonicalJson(run.plan_document)) !== expectedPlan) throw new Error("stored rollback manifest hash mismatch");
  const transitions = Number((await client.query("SELECT count(*) count FROM tender.notice_lifecycle_transitions WHERE correction_run_id=$1", [runId])).rows[0].count);
  if (run.status === "ROLLED_BACK") {
    if (transitions !== 0) throw new Error("rolled-back run still owns lifecycle transitions");
    await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "APPLY" : "DRY_RUN", idempotent: true, runId, planSha256: expectedPlan, transitionsRemaining: 0 }));
  } else {
    if (run.status !== "APPLIED") throw new Error(`correction run is not APPLIED (${run.status})`);
    const state = (await client.query(`SELECT count(*)::int rows,
        count(*) FILTER(WHERE t.source_lifecycle_status IS DISTINCT FROM c.applied_tender->>'source_lifecycle_status'
          OR t.participation_status IS DISTINCT FROM c.applied_tender->>'participation_status'
          OR t.notice_classification IS DISTINCT FROM c.applied_tender->>'notice_classification'
          OR t.participation_block_reason IS DISTINCT FROM nullif(c.applied_tender->>'participation_block_reason','')
          OR t.offer_deadline IS DISTINCT FROM nullif(c.applied_tender->>'offer_deadline','')::timestamptz)::int conflicts
      FROM tender.notice_lifecycle_correction_rows c JOIN tender.tenders t ON t.id=c.tender_id WHERE c.run_id=$1`, [runId])).rows[0];
    if (Number(state.rows) !== Number(run.planned_row_count) || Number(state.conflicts) !== 0) throw new Error(`rollback precondition failed: rows=${state.rows}, conflicts=${state.conflicts}`);
    if (apply) {
      await client.query("DELETE FROM tender.notice_lifecycle_transitions WHERE correction_run_id=$1", [runId]);
      await client.query("DELETE FROM tender.tender_lot_lifecycles l USING tender.notice_lifecycle_correction_rows c WHERE c.run_id=$1 AND l.tender_id=c.tender_id", [runId]);
      await client.query("DELETE FROM tender.tender_deadline_evidence e USING tender.notice_lifecycle_correction_rows c WHERE c.run_id=$1 AND e.tender_id=c.tender_id", [runId]);
      await client.query("DELETE FROM tender.tender_notice_relationships r USING tender.notice_lifecycle_correction_rows c WHERE c.run_id=$1 AND r.source_tender_id=c.tender_id", [runId]);
      await client.query(`INSERT INTO tender.tender_deadline_evidence SELECT (jsonb_populate_record(NULL::tender.tender_deadline_evidence,item)).*
        FROM tender.notice_lifecycle_correction_rows c CROSS JOIN LATERAL jsonb_array_elements(c.previous_deadline_evidence) item WHERE c.run_id=$1`, [runId]);
      await client.query(`INSERT INTO tender.tender_lot_lifecycles SELECT (jsonb_populate_record(NULL::tender.tender_lot_lifecycles,item)).*
        FROM tender.notice_lifecycle_correction_rows c CROSS JOIN LATERAL jsonb_array_elements(c.previous_lot_lifecycles) item WHERE c.run_id=$1`, [runId]);
      await client.query(`INSERT INTO tender.tender_notice_relationships SELECT (jsonb_populate_record(NULL::tender.tender_notice_relationships,item)).*
        FROM tender.notice_lifecycle_correction_rows c CROSS JOIN LATERAL jsonb_array_elements(c.previous_relationships) item WHERE c.run_id=$1`, [runId]);
      await client.query(`UPDATE tender.tenders t SET source_lifecycle_status=c.previous_tender->>'source_lifecycle_status',participation_status=nullif(c.previous_tender->>'participation_status',''),notice_classification=nullif(c.previous_tender->>'notice_classification',''),participation_block_reason=nullif(c.previous_tender->>'participation_block_reason',''),offer_deadline=nullif(c.previous_tender->>'offer_deadline','')::timestamptz,notice_type_code=nullif(c.previous_tender->>'notice_type_code',''),notice_subtype=nullif(c.previous_tender->>'notice_subtype',''),notice_form_type=nullif(c.previous_tender->>'notice_form_type',''),procedure_identifier=nullif(c.previous_tender->>'procedure_identifier',''),updated_at=now()
        FROM tender.notice_lifecycle_correction_rows c WHERE c.run_id=$1 AND t.id=c.tender_id`, [runId]);
      const verify = (await client.query(`SELECT
          count(*) FILTER(WHERE t.source_lifecycle_status IS DISTINCT FROM c.previous_tender->>'source_lifecycle_status'
            OR t.participation_status IS DISTINCT FROM nullif(c.previous_tender->>'participation_status','')
            OR t.notice_classification IS DISTINCT FROM nullif(c.previous_tender->>'notice_classification','')
            OR t.participation_block_reason IS DISTINCT FROM nullif(c.previous_tender->>'participation_block_reason','')
            OR t.offer_deadline IS DISTINCT FROM nullif(c.previous_tender->>'offer_deadline','')::timestamptz)::int tender_conflicts,
          (SELECT count(*)::int FROM tender.notice_lifecycle_transitions WHERE correction_run_id=$1) transition_rows
        FROM tender.notice_lifecycle_correction_rows c JOIN tender.tenders t ON t.id=c.tender_id WHERE c.run_id=$1`, [runId])).rows[0];
      if (Number(verify.tender_conflicts) || Number(verify.transition_rows)) throw new Error(`rollback verification failed: ${JSON.stringify(verify)}`);
      await client.query("UPDATE tender.notice_lifecycle_correction_runs SET status='ROLLED_BACK',rolled_back_at=now() WHERE run_id=$1", [runId]);
      await client.query("INSERT INTO tender.audit_events(action,metadata) VALUES('NOTICE_LIFECYCLE_CORRECTION_ROLLED_BACK',$1::jsonb)", [JSON.stringify({ runId, planSha256: expectedPlan, restoredRows: Number(state.rows), removedTransitions: transitions, externalWrite: false })]);
      await client.query("COMMIT");
      console.log(JSON.stringify({ mode: "APPLY", runId, planSha256: expectedPlan, restoredRows: Number(state.rows), removedTransitions: transitions, transitionsRemaining: 0 }));
    } else {
      await client.query("ROLLBACK");
      console.log(JSON.stringify({ mode: "DRY_RUN", runId, planSha256: expectedPlan, rows: Number(state.rows), conflicts: Number(state.conflicts), transitions }));
    }
  }
} catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
finally { client.release(); await pool.end(); }
