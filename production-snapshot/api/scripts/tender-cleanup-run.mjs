import { readFileSync } from "node:fs";
import pg from "pg";
import { runTenderCleanup } from "../platform/tender-cleanup.mjs";

const connectionString = process.env.DATABASE_URL || readFileSync(process.env.DATABASE_URL_FILE,"utf8").trim();
const pool = new pg.Pool({connectionString,max:2});
try {
  const latest = (await pool.query(`SELECT DISTINCT ON(source_code) id,source_code,status,outcome_status,finished_at
    FROM tender.scheduler_runs WHERE source_code=ANY($1::text[]) ORDER BY source_code,started_at DESC`,[["TED","DOE"]])).rows;
  const syncSucceeded = latest.length===2 && latest.every((row) => row.status==='SUCCESS' && row.outcome_status==='SUCCESS' && row.finished_at && Date.now()-new Date(row.finished_at).getTime()<30*60*60*1000);
  const result = await runTenderCleanup(pool,{syncSucceeded,syncRunIds:latest.map((row)=>row.id),batchSize:Number(process.env.TENDER_CLEANUP_BATCH_SIZE||100),runKind:"MANUAL"});
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode=1;
} finally { await pool.end(); }
