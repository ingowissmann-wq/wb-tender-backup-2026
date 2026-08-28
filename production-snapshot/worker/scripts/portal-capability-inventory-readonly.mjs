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
  const rows=(await client.query(`SELECT registry.id portal_id,registry.display_name,registry.canonical_domain,
      registry.portal_family_key,registry.adapter_id,registry.adapter_enabled,
      registry.adapter_validation_status,profile.portal_type,feature.feature_key,
      feature.portal_support,feature.autopilot_supported,feature.actively_configured,
      feature.production_tested,feature.browser_acceptance_passed,feature.verified_at,
      feature.evidence_note
    FROM tender.portal_registry registry
    JOIN tender.portal_capability_profiles profile ON profile.portal_id=registry.id
    JOIN tender.portal_capability_features feature ON feature.profile_id=profile.id
    WHERE registry.adapter_enabled
    ORDER BY registry.canonical_domain,feature.feature_key`)).rows;
  const portals=[];
  for(const row of rows){
    let portal=portals.find(item=>item.portalId===row.portal_id);
    if(!portal){portal={portalId:row.portal_id,portal:row.display_name,domain:row.canonical_domain,
      family:row.portal_family_key,adapterId:row.adapter_id,adapterValidationStatus:row.adapter_validation_status,
      portalType:row.portal_type,features:[]};portals.push(portal)}
    portal.features.push({feature:row.feature_key,portalSupport:row.portal_support,
      autopilotSupported:row.autopilot_supported,activelyConfigured:row.actively_configured,
      productionTested:row.production_tested,browserAcceptancePassed:row.browser_acceptance_passed,
      verifiedAt:row.verified_at,evidenceNote:row.evidence_note});
  }
  await client.query("ROLLBACK");
  console.log(JSON.stringify({capturedAt:new Date().toISOString(),transaction:"READ_ONLY_ROLLED_BACK",
    enabledPortalCount:portals.length,portals},null,2));
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{await client.release();await rawPool.end()}
