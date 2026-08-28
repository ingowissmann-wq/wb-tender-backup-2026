import { readFileSync } from "node:fs";
import pg from "pg";
import { cleanupDryRun } from "../platform/tender-cleanup.mjs";

const connectionString = process.env.DATABASE_URL || readFileSync(process.env.DATABASE_URL_FILE,"utf8").trim();
const pool = new pg.Pool({connectionString,max:1,options:"-c default_transaction_read_only=on"});
try {
  const result = await cleanupDryRun(pool);
  console.log(JSON.stringify(result));
} finally { await pool.end(); }
