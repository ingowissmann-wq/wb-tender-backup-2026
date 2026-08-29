import { readFileSync } from "node:fs";
import pg from "pg";

if (process.env.ALLOW_REGIONS_INBOX_MIGRATION_REHEARSAL !== "true") throw new Error("migration_rehearsal_not_authorized");
const url = new URL(readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim());
if (url.hostname !== process.env.EXPECTED_REHEARSAL_DB_HOST) throw new Error("rehearsal_database_host_mismatch");
if (process.env.REHEARSAL_DB_HOST_OVERRIDE) {
  if (process.env.REHEARSAL_DB_HOST_OVERRIDE !== process.env.EXPECTED_REHEARSAL_DB_HOST_OVERRIDE) throw new Error("rehearsal_database_override_mismatch");
  url.hostname = process.env.REHEARSAL_DB_HOST_OVERRIDE;
}
const connectionString = url.href;
const pool = new pg.Pool({ connectionString, max: 1 });
const up = readFileSync(process.env.MIGRATION_UP_FILE, "utf8");
const down = readFileSync(process.env.MIGRATION_DOWN_FILE, "utf8");
const executeStatements = async (sql) => {
  for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean)) await pool.query(statement);
};
try {
  const before = (await pool.query("SELECT to_regclass('tender.region_evaluations_management_inbox_exact_idx') IS NOT NULL present")).rows[0].present;
  if (before) throw new Error("rehearsal_index_already_present");
  await executeStatements(up);
  const afterUp = (await pool.query(`SELECT i.indisvalid AND i.indisready valid
    FROM pg_index i WHERE i.indexrelid='tender.region_evaluations_management_inbox_exact_idx'::regclass`)).rows[0]?.valid === true;
  if (!afterUp) throw new Error("rehearsal_index_not_valid");
  await executeStatements(down);
  const afterDown = !(await pool.query("SELECT to_regclass('tender.region_evaluations_management_inbox_exact_idx') IS NOT NULL present")).rows[0].present;
  if (!afterDown) throw new Error("rehearsal_rollback_failed");
  console.log(JSON.stringify({passed:true,target:"RESTORE_STAGING_ONLY",before,afterUp,afterDown,dataChanged:false,externalWrite:false,transmitted:false}));
} finally {
  await pool.end();
}
