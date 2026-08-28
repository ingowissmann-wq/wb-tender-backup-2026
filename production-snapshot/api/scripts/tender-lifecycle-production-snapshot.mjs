import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim(),
});
const client = await pool.connect();

async function snap(name, sql) {
  const { rows } = await client.query(sql);
  return [name, rows[0]];
}

const full = (table, order = "id") => `
  SELECT count(*)::int rows,
         encode(digest(coalesce(string_agg(to_jsonb(x)::text,E'\\n' ORDER BY ${order}),''),'sha256'),'hex') sha256
  FROM tender.${table} x`;

try {
  await client.query("BEGIN READ ONLY");
  const entries = await Promise.all([
    snap("tenders", `SELECT count(*)::int rows,encode(digest(coalesce(string_agg(concat_ws('|',id,source_code,external_id,coalesce(offer_deadline::text,''),status,source_lifecycle_status,coalesce(source_withdrawn_at::text,''),classification_status,coalesce(wb_relevance_status,''),coalesce(assigned_service_line,''),coalesce(raw_sha256,'')),E'\\n' ORDER BY id),''),'sha256'),'hex') sha256 FROM tender.tenders`),
    snap("tenderVersions", `SELECT count(*)::int rows,encode(digest(coalesce(string_agg(concat_ws('|',id,tender_id,version,source_sha256,change_kind,coalesce(source_timestamp::text,''),coalesce(normalized_data->>'sourceLifecycleStatus',''),coalesce(normalized_data->>'sourceStatus','')),E'\\n' ORDER BY tender_id,version),''),'sha256'),'hex') sha256 FROM tender.tender_versions`),
    snap("managementInbox", full("management_inbox")),
    snap("regionEvaluations", full("region_evaluations", "tender_id,company_id,evaluation_version,id")),
    snap("regionProfiles", full("region_profile_versions", "company_id,canonical_service,version_no,id")),
    snap("regionRules", full("region_profile_rules", "region_version_id,ordinal,id")),
    snap("regionZones", full("region_zones", "code,version,id")),
    snap("portalRegistry", full("portal_registry", "canonical_domain,id")),
    snap("credentialMetadata", `SELECT count(*)::int rows,encode(digest(coalesce(string_agg(concat_ws('|',id,portal_id,version,status,coalesce(revoked_at::text,''),read_only,submission_capable,account_confirmed,coalesce(account_type,''),coalesce(array_to_string(authorized_capabilities,','),''),coalesce(bound_host,'')),E'\\n' ORDER BY id,version),''),'sha256'),'hex') sha256 FROM tender.portal_credential_secrets`),
    snap("credentialPayloads", `SELECT count(*)::int rows,encode(digest(coalesce(string_agg(encode(ciphertext,'hex')||':'||encode(iv,'hex')||':'||encode(auth_tag,'hex')||':'||key_version::text,E'\\n' ORDER BY id,version),''),'sha256'),'hex') sha256 FROM tender.portal_credential_secrets`),
    snap("credentialScopes", full("portal_credential_companies", "credential_id,company_id")),
    snap("portalSessions", full("portal_read_sessions", "id")),
    snap("queue", full("autopilot_queue", "id")),
    snap("decisions", full("decisions", "tender_id,version,id")),
    snap("decisionOverrides", full("decision_overrides", "id")),
    snap("companyProfiles", full("company_profiles", "company_id,version,id")),
    snap("companyProfileEvidence", `SELECT count(*)::int rows,encode(digest(coalesce(string_agg(concat_ws('|',id,company_profile_id,company_id,field_key,evidence_version,coalesce(filename,''),coalesce(media_type,''),size_bytes,sha256,malware_scan_status,validation_status,is_current),E'\\n' ORDER BY id,evidence_version),''),'sha256'),'hex') sha256 FROM tender.company_profile_field_evidence`),
    snap("calculations", full("calculations", "tender_id,company_id,version,id")),
    snap("calculationInputs", full("calculation_input_snapshots", "id")),
    snap("documents", `SELECT count(*)::int rows,encode(digest(coalesce(string_agg(concat_ws('|',id,tender_id,source_url,display_name,sha256,created_at),E'\\n' ORDER BY id),''),'sha256'),'hex') sha256 FROM tender.documents`),
    snap("enrichmentDocuments", `SELECT count(*)::int rows,encode(digest(coalesce(string_agg(concat_ws('|',id,enrichment_version_id,coalesce(lot_id::text,''),source_url,document_type,filename,fetch_status,coalesce(http_status::text,''),coalesce(mime_type,''),coalesce(payload_sha256,''),coalesce(resolution_status,''),coalesce(document_class,''),coalesce(procurement_relevant::text,'')),E'\\n' ORDER BY id),''),'sha256'),'hex') sha256 FROM tender.enrichment_documents`),
    snap("approvals", full("approval_requests", "tender_id,created_at,id")),
    snap("bidPackages", full("bid_packages", "tender_id,version,id")),
  ]);
  const commercialTables = (await client.query(`SELECT count(*)::int rows FROM information_schema.tables WHERE table_schema='tender' AND (table_name ILIKE '%license%' OR table_name ILIKE '%payment%' OR table_name ILIKE '%subscription%' OR table_name ILIKE '%stripe%' OR table_name ILIKE '%entitlement%')`)).rows[0];
  await client.query("ROLLBACK");
  const output=JSON.stringify({ ...Object.fromEntries(entries), commercialTablesInTenderService: commercialTables.rows }, null, 2);
  if(process.env.SNAPSHOT_OUTPUT_FILE)writeFileSync(process.env.SNAPSHOT_OUTPUT_FILE,`${output}\n`,{flag:"wx",mode:0o600});
  console.log(output);
} finally {
  client.release();
  await pool.end();
}
