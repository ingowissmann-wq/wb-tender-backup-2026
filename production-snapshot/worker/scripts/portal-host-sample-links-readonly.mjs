import fs from "node:fs";
import pg from "pg";
import {createFixedScopedPool,loadBackgroundScope} from "../platform/scoped-pg-pool.mjs";

const host=String(process.argv[2]||"").trim().toLowerCase();
if(!/^[a-z0-9.-]+$/.test(host))throw new Error("host_required");
const connectionString=process.env.DATABASE_URL||fs.readFileSync(
  process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8").trim();
const rawPool=new pg.Pool({connectionString,max:1,options:"-c default_transaction_read_only=on -c statement_timeout=60000"});
const pool=createFixedScopedPool(rawPool,await loadBackgroundScope(rawPool)).pool;
const client=await pool.connect();
try{
  await client.query("BEGIN READ ONLY");
  const rows=(await client.query(`SELECT DISTINCT ON(link.tender_id)
      link.tender_id,tender.external_id,tender.source_lifecycle_status,
      link.role,link.original_url,link.final_url
    FROM tender.tender_external_links link
    JOIN tender.tenders tender ON tender.id=link.tender_id
    WHERE (lower(link.original_host)=$1 OR lower(link.final_host)=$1)
      AND tender.source_lifecycle_status='ACTIVE'
    ORDER BY link.tender_id,link.updated_at DESC NULLS LAST,link.created_at DESC
    LIMIT 20`,[host])).rows;
  await client.query("ROLLBACK");
  console.log(JSON.stringify({capturedAt:new Date().toISOString(),transaction:"READ_ONLY_ROLLED_BACK",
    host,count:rows.length,rows},null,2));
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}
finally{await client.release();await rawPool.end()}
