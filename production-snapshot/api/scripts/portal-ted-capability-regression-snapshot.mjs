import { readFileSync } from "node:fs";
import pg from "pg";

const pool = new pg.Pool({
  connectionString: readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim(),
});
const client = await pool.connect();

const snapshot = async (table, order, expression = "to_jsonb(row_data)::text") => {
  const result = await client.query(
    `SELECT count(*)::int AS rows,
            encode(digest(coalesce(string_agg(${expression}, E'\\n' ORDER BY ${order}), ''), 'sha256'), 'hex') AS sha256
       FROM tender.${table} row_data`,
  );
  return result.rows[0];
};

try {
  await client.query("BEGIN READ ONLY");
  const result = {
    companyProfiles: await snapshot("company_profiles", "id,version"),
    companyProfileEvidence: await snapshot("company_profile_field_evidence", "id,evidence_version"),
    companyProfileApprovals: await snapshot("company_profile_approvals", "id"),
    regionProfiles: await snapshot("region_profile_versions", "id,version_no"),
    regionRules: await snapshot("region_profile_rules", "id,ordinal"),
    regionZones: await snapshot("region_zones", "id,version"),
    managementInbox: await snapshot("management_inbox", "id"),
    decisions: await snapshot("decisions", "id,version"),
    decisionOverrides: await snapshot("decision_overrides", "id"),
    portalRegistry: await snapshot("portal_registry", "id"),
    credentials: await snapshot(
      "portal_credential_secrets",
      "id,version",
      "concat_ws('|',id,portal_id,version,status,coalesce(revoked_at::text,''),read_only,submission_capable,account_confirmed,coalesce(account_type,''),coalesce(array_to_string(authorized_capabilities,','),''),coalesce(bound_host,''))",
    ),
    credentialScopes: await snapshot("portal_credential_companies", "credential_id,company_id"),
    tenders: await snapshot(
      "tenders",
      "id",
      "concat_ws('|',id,status,coalesce(source_lifecycle_status,''),coalesce(classification_status,''),coalesce(wb_relevance_status,''),coalesce(assigned_service_line,''),coalesce(raw_sha256,''))",
    ),
  };
  const queue = await client.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status IN ('PENDING','QUEUED','CLAIMED','RUNNING','RETRY'))::int AS active,
            count(*) FILTER (WHERE status IN ('CLAIMED','RUNNING') AND (timeout_at IS NULL OR timeout_at>now()))::int AS leases
       FROM tender.autopilot_queue`,
  );
  result.queue = queue.rows[0];
  await client.query("ROLLBACK");
  console.log(JSON.stringify(result, null, 2));
} finally {
  client.release();
  await pool.end();
}
