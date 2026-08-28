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
  const rows=(await client.query(`WITH resolutions AS(
      SELECT portal_id,count(*)::int total,
        count(*) FILTER(WHERE resolution_status='UNIQUE_EVIDENCE')::int unique_evidence,
        count(DISTINCT tender_id) FILTER(WHERE resolution_status='UNIQUE_EVIDENCE')::int unique_tenders,
        array_agg(DISTINCT evidence_role ORDER BY evidence_role) FILTER(WHERE evidence_role IS NOT NULL) evidence_roles
      FROM tender.tender_portal_resolutions GROUP BY portal_id
    ), links AS(
      SELECT registry.id portal_id,count(*)::int total,count(DISTINCT link.tender_id)::int tenders,
        array_agg(DISTINCT link.role ORDER BY link.role) roles,
        count(*) FILTER(WHERE link.verification_status='HTTP_VERIFIED')::int http_verified,
        count(*) FILTER(WHERE link.role='SUBMISSION')::int submission_links,
        count(*) FILTER(WHERE link.role IN('PUBLIC_DOCUMENT','PROCUREMENT_DOCUMENT'))::int document_links
      FROM tender.portal_registry registry
      JOIN tender.tender_external_links link
        ON lower(coalesce(link.final_host,link.original_host))=registry.canonical_domain
          OR lower(coalesce(link.final_host,link.original_host))=ANY(registry.allowed_subdomains)
      GROUP BY registry.id
    ), credentials AS(
      SELECT portal_id,count(DISTINCT credential.id) FILTER(WHERE credential.status='ACTIVE')::int active_credentials,
        count(DISTINCT company.company_id) FILTER(WHERE credential.status='ACTIVE' AND company.active)::int scoped_companies
      FROM tender.portal_credential_secrets credential
      LEFT JOIN tender.portal_credential_companies company ON company.credential_id=credential.id
      GROUP BY portal_id
    )
    SELECT registry.id portal_id,registry.display_name,registry.canonical_domain,registry.portal_family_key,
      profile.portal_type,registry.entrypoint_type,registry.adapter_id,registry.adapter_enabled,
      registry.adapter_validation_status,coalesce(resolutions.total,0) resolution_count,
      coalesce(resolutions.unique_evidence,0) unique_resolution_count,
      coalesce(resolutions.unique_tenders,0) unique_tender_count,
      coalesce(resolutions.evidence_roles,'{}') resolution_roles,
      coalesce(links.total,0) external_link_count,coalesce(links.tenders,0) linked_tender_count,
      coalesce(links.roles,'{}') external_link_roles,coalesce(links.http_verified,0) verified_link_count,
      coalesce(links.submission_links,0) submission_link_count,coalesce(links.document_links,0) document_link_count,
      coalesce(credentials.active_credentials,0) active_credential_count,
      coalesce(credentials.scoped_companies,0) credential_company_count
    FROM tender.portal_registry registry
    LEFT JOIN tender.portal_capability_profiles profile ON profile.portal_id=registry.id
    LEFT JOIN resolutions ON resolutions.portal_id=registry.id
    LEFT JOIN links ON links.portal_id=registry.id
    LEFT JOIN credentials ON credentials.portal_id=registry.id
    ORDER BY registry.canonical_domain`)).rows;
  const roleTotals={};
  for(const row of rows)for(const role of [...row.resolution_roles,...row.external_link_roles])roleTotals[role]=(roleTotals[role]||0)+1;
  const zeroEvidence=rows.filter(row=>!row.resolution_count&&!row.external_link_count&&!row.active_credential_count);
  await client.query("ROLLBACK");
  console.log(JSON.stringify({capturedAt:new Date().toISOString(),transaction:"READ_ONLY_ROLLED_BACK",
    portalCount:rows.length,roleTotals,zeroEvidencePortalCount:zeroEvidence.length,
    zeroEvidencePortals:zeroEvidence.map(row=>({portalId:row.portal_id,domain:row.canonical_domain,
      adapterStatus:row.adapter_validation_status})),portals:process.argv.includes("--detail")?rows:undefined},null,2));
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{await client.release();await rawPool.end()}
