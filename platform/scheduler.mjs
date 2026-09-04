import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import pg from "pg";
import { runIngestion } from "./source-ingestion.mjs";

if (process.env.DATABASE_URL) throw new Error("inline_secret_forbidden_database_url");
const databaseFile = process.env.DATABASE_URL_FILE;
if (!databaseFile) throw new Error("database_url_file_required");
if (String(process.env.EXTERNAL_SUBMISSION_ENABLED).toLowerCase() !== "false" || String(process.env.WB_TENDER_ALLOW_EXTERNAL_SUBMISSION).toLowerCase() !== "false") throw new Error("external_submission_must_remain_disabled");

const pool = new pg.Pool({ connectionString: readFileSync(databaseFile, "utf8").trim(), max: 2, options: "-c tender.pipeline_job_id=DAILY_INBOX_PIPELINE" });
let ready = false;
let stopping = false;
const server = createServer((request, response) => {
  if (!["/health", "/healthz"].includes(request.url)) { response.writeHead(404); response.end(); return; }
  response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: ready ? "ok" : "starting", component: "source-ingestion-scheduler", externalSubmissionEnabled: false }));
});
await new Promise((resolve, reject) => server.once("error", reject).listen(Number(process.env.PORT || 4240), process.env.HOST || "0.0.0.0", resolve));

const shutdown = () => { stopping = true; };
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
try {
  await pool.query("SELECT 1");
  ready = true;
  if (process.env.SCHEDULER_REHEARSAL_IDLE === "true") {
    while (!stopping) {
      await pool.query("SELECT 1");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  } else {
    await runIngestion({ once: false });
  }
} finally {
  ready = false;
  await pool.end();
  await new Promise((resolve) => server.close(resolve));
}
