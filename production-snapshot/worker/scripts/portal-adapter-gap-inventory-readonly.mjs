import fs from "node:fs";
import pg from "pg";
import {createFixedScopedPool,loadBackgroundScope} from "../platform/scoped-pg-pool.mjs";

const connectionString=process.env.DATABASE_URL||fs.readFileSync(
  process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8",
).trim();
const rawPool=new pg.Pool({connectionString,max:1,options:["-c default_transaction_read_only=on -c statement_timeout=120000",process.env.DATABASE_SESSION_OPTIONS].filter(Boolean).join(" ")});
const pool=createFixedScopedPool(rawPool,await loadBackgroundScope(rawPool)).pool;
const client=await pool.connect();
try{
  await client.query("BEGIN READ ONLY");
  const rows=(await client.query(`SELECT registry.id portal_id,registry.display_name,
      registry.canonical_domain,registry.portal_family_key,registry.adapter_id,
      registry.adapter_enabled,registry.adapter_validation_status,
      registry.entrypoint_type,coalesce(profile.portal_type,'UNCLASSIFIED') portal_type,
      registry.authentication_entry_url,registry.registration_entry_url,registry.bidder_area_url,
      registry.capabilities,
      (SELECT count(DISTINCT resolution.tender_id) FROM tender.tender_portal_resolutions resolution
        WHERE resolution.portal_id=registry.id AND resolution.resolution_status='UNIQUE_EVIDENCE')::int resolved_tenders,
      (SELECT count(DISTINCT link.tender_id) FROM tender.tender_external_links link
        WHERE lower(coalesce(link.final_host,link.original_host))=registry.canonical_domain
          OR lower(coalesce(link.final_host,link.original_host))=ANY(registry.allowed_subdomains))::int linked_tenders
    FROM tender.portal_registry registry
    LEFT JOIN tender.portal_capability_profiles profile ON profile.portal_id=registry.id
    WHERE registry.adapter_validation_status='NEEDS_ADAPTER_IMPLEMENTATION'
    ORDER BY registry.canonical_domain`)).rows;
  await client.query("ROLLBACK");
  console.log(JSON.stringify({capturedAt:new Date().toISOString(),transaction:"READ_ONLY_ROLLED_BACK",
    gapCount:rows.length,portals:rows},null,2));
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{await client.release();await rawPool.end()}
