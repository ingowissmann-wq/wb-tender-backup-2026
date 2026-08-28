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
  options: "-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=3000",
});
const pool = createFixedScopedPool(rawPool, await loadBackgroundScope(rawPool)).pool;
const client = await pool.connect();
try {
  await client.query("BEGIN READ ONLY");
  const result = (await client.query(`SELECT current_user runtime_role,
    has_table_privilege(current_user,'tender.tender_external_links','SELECT,INSERT,UPDATE') external_link_write,
    has_table_privilege(current_user,'tender.tender_portal_resolutions','SELECT,INSERT,UPDATE') resolution_write,
    has_table_privilege(current_user,'tender.tender_portal_assignments','SELECT,INSERT,UPDATE') assignment_write,
    has_table_privilege(current_user,'tender.autopilot_queue','SELECT,INSERT,UPDATE') queue_write,
    (SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY conname)
      FROM pg_constraint WHERE conrelid='tender.tender_portal_resolutions'::regclass) resolution_constraints,
    (SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY conname)
      FROM pg_constraint WHERE conrelid='tender.tender_portal_assignments'::regclass) assignment_constraints`)).rows[0];
  await client.query("ROLLBACK");
  console.log(JSON.stringify({ ...result, transaction: "READ_ONLY_ROLLED_BACK" }, null, 2));
} finally {
  await client.release();
  await rawPool.end();
}
