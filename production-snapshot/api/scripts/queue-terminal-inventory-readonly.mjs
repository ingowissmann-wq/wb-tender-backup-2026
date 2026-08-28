import fs from "node:fs";
import pg from "pg";
import { createFixedScopedPool, loadBackgroundScope } from "../platform/scoped-pg-pool.mjs";

const connectionString = process.env.DATABASE_URL || fs.readFileSync(
  process.env.DATABASE_URL_FILE || "/run/secrets/database_url",
  "utf8",
).trim();
const rawPool = new pg.Pool({
  connectionString,
  max: 1,
  options: "-c default_transaction_read_only=on -c statement_timeout=120000",
});
const pool = createFixedScopedPool(rawPool, await loadBackgroundScope(rawPool)).pool;
const client = await pool.connect();

try {
  await client.query("BEGIN READ ONLY");
  const byReason = (await client.query(`
    SELECT q.status,
      coalesce(q.safe_error_code,q.error_code,'NO_ERROR_CODE') reason_code,
      count(*)::int count,
      count(*) FILTER (WHERE t.data_class='PUBLIC_REAL')::int public_real,
      count(*) FILTER (WHERE t.data_class='PUBLIC_REAL' AND t.source_lifecycle_status='ACTIVE')::int active_public_real,
      count(*) FILTER (WHERE t.data_class='PUBLIC_REAL' AND t.source_lifecycle_status='ACTIVE'
        AND coalesce(t.offer_deadline,t.participation_deadline)>now())::int active_open,
      max(q.finished_at) latest_finished_at
    FROM tender.autopilot_queue q
    LEFT JOIN tender.tenders t ON t.id=q.tender_id
    WHERE q.status IN('DEAD_LETTER','FAILED')
    GROUP BY q.status,coalesce(q.safe_error_code,q.error_code,'NO_ERROR_CODE')
    ORDER BY active_open DESC,active_public_real DESC,count(*) DESC,q.status,reason_code
  `)).rows;
  const activeOpen = (await client.query(`
    SELECT q.id,q.status,q.action_type,q.current_step,
      coalesce(q.safe_error_code,q.error_code,'NO_ERROR_CODE') reason_code,
      q.finished_at,q.tender_id,q.company_id,q.lot_id,q.lot_key,
      t.external_id,t.source_code,t.offer_deadline,t.participation_deadline,
      EXISTS(SELECT 1 FROM tender.lots l WHERE l.id=q.lot_id AND l.tender_id=q.tender_id) canonical_lot_id,
      EXISTS(SELECT 1 FROM tender.pipeline_contexts p
        WHERE p.tender_id=q.tender_id AND p.company_id=q.company_id
          AND p.lot_key=coalesce(q.lot_key,'')) exact_pipeline_context
    FROM tender.autopilot_queue q
    JOIN tender.tenders t ON t.id=q.tender_id
    WHERE q.status IN('DEAD_LETTER','FAILED')
      AND t.data_class='PUBLIC_REAL' AND t.source_lifecycle_status='ACTIVE'
      AND coalesce(t.offer_deadline,t.participation_deadline)>now()
    ORDER BY q.finished_at DESC NULLS LAST,q.id
  `)).rows;
  const latestActiveOpen = (await client.query(`
    WITH ranked AS (
      SELECT q.*,row_number() OVER(
        PARTITION BY q.company_id,q.tender_id,coalesce(q.lot_key,''),q.action_type
        ORDER BY q.created_at DESC,q.id DESC
      ) AS position
      FROM tender.autopilot_queue q
      JOIN tender.tenders t ON t.id=q.tender_id
      WHERE t.data_class='PUBLIC_REAL' AND t.source_lifecycle_status='ACTIVE'
        AND coalesce(t.offer_deadline,t.participation_deadline)>now()
    )
    SELECT status,coalesce(safe_error_code,error_code,'NO_ERROR_CODE') reason_code,
      count(*)::int count,max(finished_at) latest_finished_at
    FROM ranked WHERE position=1 AND status IN('DEAD_LETTER','FAILED')
    GROUP BY status,coalesce(safe_error_code,error_code,'NO_ERROR_CODE')
    ORDER BY count(*) DESC,status,reason_code
  `)).rows;
  const latestActiveOpenDetails = process.argv.includes("--detail") ? (await client.query(`
    WITH ranked AS (
      SELECT q.*,row_number() OVER(
        PARTITION BY q.company_id,q.tender_id,coalesce(q.lot_key,''),q.action_type
        ORDER BY q.created_at DESC,q.id DESC
      ) AS position
      FROM tender.autopilot_queue q
      JOIN tender.tenders t ON t.id=q.tender_id
      WHERE t.data_class='PUBLIC_REAL' AND t.source_lifecycle_status='ACTIVE'
        AND coalesce(t.offer_deadline,t.participation_deadline)>now()
    )
    SELECT q.id,q.status,q.action_type,q.current_step,
      coalesce(q.safe_error_code,q.error_code,'NO_ERROR_CODE') reason_code,
      q.created_at,q.finished_at,q.tender_id,q.company_id,q.lot_id,q.lot_key
    FROM ranked q WHERE q.position=1 AND q.status IN('DEAD_LETTER','FAILED')
    ORDER BY q.finished_at DESC NULLS LAST,q.id
  `)).rows : undefined;
  let migrations;
  try {
    migrations = (await client.query(`
      SELECT version,description FROM app.schema_migrations
      WHERE version=ANY($1::text[]) ORDER BY version
    `, [[
      "0122-portal-credential-secret-insert-scope",
      "0134-runtime-child-scope-rls",
      "0135-participation-terminal-truth",
      "0136-portal-human-continuation-truth",
      "0137-canonical-context-retry",
      "0138-canonical-technical-retry",
      "0139-pipeline-repair-continuation-truth",
    ]])).rows;
  } catch (error) {
    if (error.code !== "42501") throw error;
    await client.query("ROLLBACK");
    await client.query("BEGIN READ ONLY");
    migrations = { status: "UNAVAILABLE_TO_RUNTIME_ROLE", reason: "SCHEMA_APP_READ_DENIED" };
  }
  const rolloutErrors = (await client.query(`
    SELECT coalesce(safe_error_code,error_code,'NO_ERROR_CODE') reason_code,count(*)::int count
    FROM tender.autopilot_queue
    WHERE created_at >= $1::timestamptz AND status IN('FAILED','DEAD_LETTER')
    GROUP BY coalesce(safe_error_code,error_code,'NO_ERROR_CODE') ORDER BY count(*) DESC
  `, [process.env.ROLLOUT_STARTED_AT || "2026-08-25T19:20:53Z"])).rows;
  await client.query("ROLLBACK");
  console.log(JSON.stringify({
    capturedAt: new Date().toISOString(),
    transaction: "READ_ONLY_ROLLED_BACK",
    rolloutStartedAt: process.env.ROLLOUT_STARTED_AT || "2026-08-25T19:20:53Z",
    migrationMarkers: migrations,
    byReason,
    historicalActiveOpenCount: activeOpen.length,
    latestActiveOpenCount: latestActiveOpen.reduce((sum, row) => sum + row.count, 0),
    latestActiveOpenByReason: latestActiveOpen,
    latestActiveOpen: latestActiveOpenDetails,
    rolloutErrors,
  }, null, 2));
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.release();
  await rawPool.end();
}
