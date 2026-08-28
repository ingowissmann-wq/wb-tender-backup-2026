import fs from "node:fs";
import pg from "pg";
import {createFixedScopedPool,loadBackgroundScope} from "../platform/scoped-pg-pool.mjs";

const connectionString=process.env.DATABASE_URL||fs.readFileSync(
  process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8",
).trim();
const rawPool=new pg.Pool({connectionString,max:1,options:["-c default_transaction_read_only=on -c statement_timeout=120000",process.env.DATABASE_SESSION_OPTIONS].filter(Boolean).join(" ")});
const pool=createFixedScopedPool(rawPool,await loadBackgroundScope(rawPool)).pool;
const client=await pool.connect();
const tables=["tender_portal_assignments","tender_portal_resolutions","enrichment_context_bindings","pipeline_contexts"];
try{
  await client.query("BEGIN READ ONLY");
  const columns=(await client.query(`SELECT table_name,column_name,data_type,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema='tender' AND table_name=ANY($1)
    ORDER BY table_name,ordinal_position`,[tables])).rows;
  const constraints=(await client.query(`SELECT table_name,constraint_name,constraint_type
    FROM information_schema.table_constraints WHERE table_schema='tender' AND table_name=ANY($1)
    ORDER BY table_name,constraint_name`,[tables])).rows;
  const indexes=(await client.query(`SELECT tablename,indexname,indexdef FROM pg_indexes
    WHERE schemaname='tender' AND tablename=ANY($1) ORDER BY tablename,indexname`,[tables])).rows;
  const views=(await client.query(`SELECT viewname,definition FROM pg_views WHERE schemaname='tender'
    AND viewname=ANY($1) ORDER BY viewname`,[["current_tender_portal_mapping_truth","current_registered_tender_company_portals",
      "current_tender_company_portal_credential_scopes"]])).rows;
  await client.query("ROLLBACK");
  console.log(JSON.stringify({capturedAt:new Date().toISOString(),transaction:"READ_ONLY_ROLLED_BACK",
    columns,constraints,indexes,views},null,2));
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{await client.release();await rawPool.end()}
