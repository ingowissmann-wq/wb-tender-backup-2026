import { readFileSync } from "node:fs";
import pg from "pg";

const pool = new pg.Pool({
  connectionString: readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim(),
});
const client = await pool.connect();
try {
  await client.query("BEGIN READ ONLY");
  const matrix = (
    await client.query(
      `SELECT portal.display_name portal,portal.canonical_domain host,
              company.legal_name company,credential.version,
              credential.read_only,credential.submission_capable,
              credential.account_confirmed,portal.adapter_enabled,
              tender.canonical_portal_adapter_validation_status(portal.adapter_validation_status) validation_status,
              coalesce(adapter.supported_actions,ARRAY[]::text[]) supported_actions,
              coalesce(portal.capabilities,ARRAY[]::text[]) registry_capabilities
       FROM tender.portal_credential_companies scope
       JOIN tender.portal_credential_secrets credential ON credential.id=scope.credential_id
       JOIN tender.portal_registry portal ON portal.id=credential.portal_id
       JOIN tender.enterprise_company_links company ON company.company_id=scope.company_id
       LEFT JOIN tender.portal_adapters adapter ON adapter.portal_code=portal.adapter_id
       WHERE scope.active=true AND credential.status='ACTIVE' AND credential.revoked_at IS NULL
       ORDER BY portal.display_name,company.legal_name`,
    )
  ).rows.map((row) => ({
    ...row,
    legacyState: "LEGACY_UNTYPED_COMPATIBLE",
    loginContinues: Boolean(
      row.adapter_enabled &&
        row.validation_status === "PRODUCTION_VALIDATED" &&
        row.supported_actions.includes("LOGIN"),
    ),
    documentContinues: Boolean(
      row.adapter_enabled &&
        row.validation_status === "PRODUCTION_VALIDATED" &&
        (row.supported_actions.includes("DOWNLOAD") ||
          row.supported_actions.includes("TEST_DOCUMENT_FETCH") ||
          row.registry_capabilities.includes("DOCUMENT_DOWNLOAD")),
    ),
    additionalRights: false,
    postMigration:
      "unchanged; nullable type/capabilities/host; explicit typing on next save",
  }));
  const stats = (
    await client.query(
      `SELECT
        (SELECT count(*)::int FROM tender.portal_credential_secrets) credentials,
        (SELECT count(*)::int FROM tender.portal_credential_secrets WHERE status='ACTIVE' AND revoked_at IS NULL) active_credentials,
        (SELECT count(*)::int FROM tender.portal_credential_secrets WHERE status='REVOKED') revoked_credentials,
        (SELECT count(*)::int FROM tender.portal_credential_secrets WHERE status='REPLACED') replaced_credentials,
        (SELECT count(*)::int FROM tender.portal_credential_companies) scopes,
        (SELECT count(*)::int FROM tender.portal_credential_companies WHERE active) active_scopes,
        (SELECT count(*)::int FROM tender.autopilot_queue WHERE status IN ('PENDING','QUEUED','CLAIMED','RUNNING','RETRY')) active_jobs,
        (SELECT count(*)::int FROM tender.autopilot_queue WHERE status IN ('CLAIMED','RUNNING') AND (timeout_at IS NULL OR timeout_at>now())) active_leases,
        (SELECT count(*)::int FROM tender.portal_read_sessions) sessions,
        (SELECT count(*)::int FROM tender.portal_login_continuations) continuations,
        (SELECT count(*)::int FROM tender.portal_registry) registry,
        (SELECT count(*)::int FROM tender.portal_registry WHERE lower(canonical_domain)='ted.europa.eu' OR lower(canonical_domain) LIKE '%.ted.europa.eu') ted_registry`,
    )
  ).rows[0];
  const hashes = (
    await client.query(
      `SELECT
        encode(digest(coalesce(string_agg(encode(ciphertext,'hex')||':'||encode(iv,'hex')||':'||encode(auth_tag,'hex')||':'||key_version::text,E'\n' ORDER BY id,version),''),'sha256'),'hex') encrypted_payload_hash,
        encode(digest(coalesce(string_agg(concat_ws('|',id,portal_id,version,status,coalesce(revoked_at::text,''),read_only,submission_capable,account_confirmed),E'\n' ORDER BY id,version),''),'sha256'),'hex') credential_metadata_hash
       FROM tender.portal_credential_secrets`,
    )
  ).rows[0];
  await client.query("ROLLBACK");
  const result = { stats, hashes, matrix };
  console.log(
    JSON.stringify(
      process.env.PREFLIGHT_COMPACT === "true"
        ? {
            stats,
            hashes,
            matrixRows: matrix.length,
            blockedAfterMigration: matrix.filter(
              (row) => !row.loginContinues && !row.documentContinues,
            ).map(({ portal, host, company, validation_status }) => ({
              portal,
              host,
              company,
              validation_status,
            })),
            additionalRightsRows: matrix.filter((row) => row.additionalRights).length,
          }
        : result,
      null,
      2,
    ),
  );
} finally {
  client.release();
  await pool.end();
}
