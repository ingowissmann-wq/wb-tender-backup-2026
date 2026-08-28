import fs from "node:fs";
import pg from "pg";

if (process.env.WB_SUBMISSION_COMPONENT !== "scheduler") {
  const response = await fetch("http://127.0.0.1:4240/healthz", { signal: AbortSignal.timeout(2500) });
  if (!response.ok) process.exit(1);
  process.exit(0);
}

if (process.env.EXTERNAL_SUBMISSION_ENABLED !== "false"
  || process.env.WB_TENDER_ALLOW_EXTERNAL_SUBMISSION !== "false"
  || process.env.WB_TENDER_SUBMISSION_GLOBAL_KILL_SWITCH !== "true") process.exit(1);

const command = fs.readFileSync("/proc/1/cmdline", "utf8");
if (!command.includes("source-ingestion.mjs")) process.exit(1);
const connectionString = fs.readFileSync(process.env.DATABASE_URL_FILE || "/run/secrets/database_url", "utf8").trim();
const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 2000 });
try {
  const sources = await pool.query(`SELECT
    count(*) FILTER(WHERE source_code IN('TED','DOE') AND enabled AND NOT kill_switch)::int ready_sources,
    count(*) FILTER(WHERE source_code IN('TED','DOE'))::int configured_sources
    FROM tender.scheduler_sources`);
  const safety = (await pool.query(`SELECT external_submission_enabled,allow_external_submission,global_kill_switch
    FROM tender.submission_runtime_settings WHERE singleton=true`)).rows[0];
  if (sources.rows[0].ready_sources !== 2 || sources.rows[0].configured_sources !== 2
    || safety?.external_submission_enabled !== false || safety?.allow_external_submission !== false
    || safety?.global_kill_switch !== true) process.exit(1);
} finally {
  await pool.end();
}
