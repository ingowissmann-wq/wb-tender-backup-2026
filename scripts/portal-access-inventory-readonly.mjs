import fs from "node:fs";
import pg from "pg";
import {createFixedScopedPool,loadBackgroundScope} from "../platform/scoped-pg-pool.mjs";

const databaseUrlFile = process.env.DATABASE_URL_FILE || "/run/secrets/database_url";
const databaseOptions = [
  "-c default_transaction_read_only=on -c statement_timeout=55000",
  process.env.DATABASE_SESSION_OPTIONS,
].filter(Boolean).join(" ");
const rawPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || fs.readFileSync(databaseUrlFile, "utf8").trim(),
  max: 1,
  options: databaseOptions,
});
const pool=createFixedScopedPool(rawPool,await loadBackgroundScope(rawPool)).pool;

const query = async (text, params = []) => (await pool.query(text, params)).rows;

try {
  const [columns, registry, accessByCompany, permissions, urlCoverage, doeSamples, tedSamples] = await Promise.all([
    query(`SELECT table_schema,table_name,column_name,data_type
      FROM information_schema.columns
      WHERE (table_schema='tender' AND table_name IN('portal_registry','portal_credential_secrets','portal_credential_companies','portal_read_sessions','enterprise_company_links','tenders','tender_versions'))
         OR (table_schema='tenant_portal' AND table_name='portal_credentials')
      ORDER BY table_schema,table_name,ordinal_position`),
    query(`SELECT display_name,canonical_domain,adapter_id,
        authentication_entry_url IS NOT NULL login_configured,
        bidder_area_url IS NOT NULL bidder_area_configured,
        cardinality(coalesce(allowed_subdomains,ARRAY[]::text[])) allowed_subdomain_count,
        adapter_validation_status,last_verified_at IS NOT NULL verified
      FROM tender.portal_registry ORDER BY canonical_domain`),
    query(`SELECT company.legal_name,
        count(DISTINCT scope.credential_id) FILTER(WHERE scope.active AND credential.status='ACTIVE')::int active_accesses,
        count(DISTINCT credential.portal_id) FILTER(WHERE scope.active AND credential.status='ACTIVE')::int active_portals,
        count(DISTINCT session.id) FILTER(WHERE session.status='ACTIVE')::int active_sessions
      FROM tender.enterprise_company_links company
      LEFT JOIN tender.portal_credential_companies scope ON scope.company_id=company.company_id
      LEFT JOIN tender.portal_credential_secrets credential ON credential.id=scope.credential_id
      LEFT JOIN tender.portal_read_sessions session ON session.credential_id=credential.id AND session.company_id=company.company_id
      WHERE company.active=true GROUP BY company.company_id,company.legal_name ORDER BY company.legal_name`),
    query(`SELECT permission.code permission_code,count(DISTINCT binding.role_id)::int roles
      FROM iam.role_permissions binding JOIN iam.permissions permission ON permission.id=binding.permission_id
      WHERE permission.code LIKE 'tender.portal.%' OR permission.code='tender.admin'
      GROUP BY permission.code ORDER BY permission.code`),
    query(`WITH latest AS(
        SELECT DISTINCT ON(v.tender_id) v.tender_id,t.source_code,t.source_url,v.normalized_data
        FROM tender.tender_versions v JOIN tender.tenders t ON t.id=v.tender_id
        WHERE t.data_class='PUBLIC_REAL' ORDER BY v.tender_id,v.version DESC
      ), urls AS(
        SELECT source_code,tender_id,source_url,
          normalized_data#>>'{raw,uri}' raw_uri,
          normalized_data#>>'{raw,links,html}' html_url,
          normalized_data#>'{raw,tender,documents}' documents
        FROM latest
      ) SELECT source_code,count(*)::int tenders,
        count(*) FILTER(WHERE source_url LIKE 'https://%')::int source_https,
        count(*) FILTER(WHERE coalesce(raw_uri,'') LIKE 'https://%')::int raw_uri_https,
        count(*) FILTER(WHERE coalesce(html_url,'') LIKE 'https://%')::int html_https,
        count(*) FILTER(WHERE jsonb_typeof(documents)='array' AND jsonb_array_length(documents)>0)::int with_payload_documents,
        count(*) FILTER(WHERE coalesce(source_url,'') ~* '/api/notices/|[?&]format=ocds')::int technical_source_urls
      FROM urls GROUP BY source_code ORDER BY source_code`),
    query(`WITH latest AS(
        SELECT DISTINCT ON(v.tender_id) t.id,t.external_id,t.source_url,v.normalized_data
        FROM tender.tender_versions v JOIN tender.tenders t ON t.id=v.tender_id
        WHERE t.data_class='PUBLIC_REAL' AND t.source_code='DOE' ORDER BY v.tender_id,v.version DESC
      ), docs AS(
        SELECT l.id,l.external_id,l.source_url,d->>'url' url,d->>'title' title,d->>'documentType' document_type
        FROM latest l CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.normalized_data#>'{raw,tender,documents}')='array' THEN l.normalized_data#>'{raw,tender,documents}' ELSE '[]'::jsonb END)d
        WHERE d->>'url' ~* '^https://'
      ) SELECT external_id,
        regexp_replace(source_url,'([?&](token|code|key|session|ticket)=[^&]+)','\\1[MASKED]','gi') source_url,
        regexp_replace(url,'([?&](token|code|key|session|ticket)=[^&]+)','\\1[MASKED]','gi') url,
        left(coalesce(title,''),120) title,document_type
      FROM docs WHERE url ~* 'meinauftrag\\.rib\\.de|tenderId' ORDER BY external_id LIMIT 12`),
    query(`WITH latest AS(
        SELECT DISTINCT ON(v.tender_id) t.external_id,t.source_url,v.normalized_data
        FROM tender.tender_versions v JOIN tender.tenders t ON t.id=v.tender_id
        WHERE t.data_class='PUBLIC_REAL' AND t.source_code='TED' ORDER BY v.tender_id,v.version DESC
      ) SELECT external_id,source_url,
        coalesce(normalized_data#>>'{raw,links,html,DEU}',normalized_data#>>'{raw,links,html,ENG}') html_url,
        coalesce(normalized_data#>>'{raw,links,htmlDirect,DEU}',normalized_data#>>'{raw,links,htmlDirect,ENG}') html_direct
      FROM latest WHERE source_url LIKE 'https://%' LIMIT 8`),
  ]);
  const names = (table) => columns.filter((column) => `${column.table_schema}.${column.table_name}` === table).map((column) => column.column_name);
  console.log(JSON.stringify({
    readOnly: true,
    schema: {
      registryColumns: names("tender.portal_registry"),
      credentialMetadataColumns: names("tender.portal_credential_secrets").filter((name) => !["ciphertext","iv","auth_tag"].includes(name)),
      credentialHasEncryptedPayload: ["ciphertext","iv","auth_tag","key_version"].every((name) => names("tender.portal_credential_secrets").includes(name)),
      sessionHasEncryptedPayload: ["ciphertext","iv","auth_tag","key_version"].every((name) => names("tender.portal_read_sessions").includes(name)),
      tenantPortalCredentialColumns: names("tenant_portal.portal_credentials"),
    },
    registrySummary: {
      hosts: registry.length,
      loginConfigured: registry.filter((item) => item.login_configured).length,
      bidderAreaConfigured: registry.filter((item) => item.bidder_area_configured).length,
      verified: registry.filter((item) => item.verified).length,
      entries: registry.filter((item) => item.login_configured || item.bidder_area_configured || /rib|meinauftrag/i.test(`${item.display_name} ${item.canonical_domain} ${item.adapter_id}`)).map((item) => ({
        displayName: item.display_name, domain: item.canonical_domain, adapterId: item.adapter_id,
        loginConfigured: item.login_configured, bidderAreaConfigured: item.bidder_area_configured,
        validationStatus: item.adapter_validation_status, verified: item.verified,
      })),
    },
    accessByCompany, permissions, urlCoverage, doeSamples, tedSamples,
  }, null, 2));
} finally {
  await rawPool.end();
}
