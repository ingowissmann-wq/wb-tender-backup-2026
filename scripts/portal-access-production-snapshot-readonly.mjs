import fs from "node:fs";
import pg from "pg";

const databaseUrlFile = process.env.DATABASE_URL_FILE || "/run/secrets/database_url";
const pool = new pg.Pool({
  connectionString: fs.readFileSync(databaseUrlFile, "utf8").trim(),
  max: 1,
  options: "-c default_transaction_read_only=on -c statement_timeout=55000",
});

const scalar = async (sql) => (await pool.query(sql)).rows[0]?.value;
try {
  const tableCounts = Object.fromEntries(await Promise.all([
    "tender.tenders", "tender.tender_versions", "tender.current_service_relevance",
    "tender.region_evaluations", "tender.management_inbox", "tender.portal_registry",
    "tender.portal_credential_secrets", "tender.portal_credential_companies",
  ].map(async (table) => [table, Number(await scalar(`SELECT count(*)::bigint value FROM ${table}`))])));
  const decisionHash = await scalar(`SELECT md5(coalesce(string_agg(concat_ws('|',id::text,decision,workflow_status,coalesce(responsible_user_id::text,''),missing_information::text,risks::text,coalesce(recommended_next_step,'')),';' ORDER BY id),'')) value FROM tender.management_inbox`);
  const regionInboxLinkHash = await scalar(`SELECT md5(coalesce(string_agg(concat_ws('|',id::text,coalesce(inbox_id::text,'')),';' ORDER BY id),'')) value FROM tender.region_evaluations`);
  const portalAccessByCompany = (await pool.query(`SELECT company.legal_name,count(*) FILTER(WHERE scope.active AND credential.status='ACTIVE')::int active_accesses
    FROM tender.enterprise_company_links company
    LEFT JOIN tender.portal_credential_companies scope ON scope.company_id=company.company_id
    LEFT JOIN tender.portal_credential_secrets credential ON credential.id=scope.credential_id
    GROUP BY company.company_id,company.legal_name ORDER BY company.legal_name`)).rows;
  const registry = (await pool.query(`SELECT count(*)::int hosts,
    count(*) FILTER(WHERE adapter_validation_status='PRODUCTION_VALIDATED')::int production_validated,
    count(*) FILTER(WHERE authentication_entry_url IS NOT NULL)::int login_urls,
    count(*) FILTER(WHERE to_jsonb(portal_registry)->>'registration_entry_url' IS NOT NULL)::int registration_urls
    FROM tender.portal_registry`)).rows[0];
  console.log(JSON.stringify({ readOnly:true, capturedAt:new Date().toISOString(), tableCounts, decisionHash, regionInboxLinkHash, portalAccessByCompany, registry }, null, 2));
} finally {
  await pool.end();
}
