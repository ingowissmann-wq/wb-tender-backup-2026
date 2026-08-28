import fs from "node:fs";
import pg from "pg";
import { createFixedScopedPool, loadBackgroundScope } from "../platform/scoped-pg-pool.mjs";
import { canonicalPortalAccessStatus } from "../platform/canonical-portal-access.mjs";

const rawPool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    fs.readFileSync(process.env.DATABASE_URL_FILE || "/run/secrets/database_url", "utf8").trim(),
  max: 1,
  options: [
    "-c default_transaction_read_only=on -c statement_timeout=55000",
    process.env.DATABASE_SESSION_OPTIONS,
  ].filter(Boolean).join(" "),
});
const pool = createFixedScopedPool(rawPool, await loadBackgroundScope(rawPool)).pool;

try {
  const companies = (await pool.query(`
    SELECT company_id,legal_name
    FROM tender.enterprise_company_links
    WHERE active=true AND legal_name LIKE 'WB-%'
    ORDER BY legal_name
  `)).rows;
  const companyIds = companies.map((row) => row.company_id);
  const credentials = (await pool.query(`
    WITH latest_session AS (
      SELECT DISTINCT ON (session.credential_id,session.company_id)
        session.credential_id,session.company_id,session.status session_status,
        session.expires_at session_expires_at,session.last_verified_at,
        session.verification_status,
        tender.portal_session_effective_status(
          session.status,session.expires_at,session.revoked_at,session.verification_status
        ) session_effective_status
      FROM tender.portal_read_sessions session
      WHERE session.company_id=ANY($1::uuid[])
      ORDER BY session.credential_id,session.company_id,session.created_at DESC
    ), latest_job AS (
      SELECT DISTINCT ON (job.credential_id,job.company_id)
        job.credential_id,job.company_id,job.status job_status,
        coalesce(job.safe_error_code,job.error_code,job.portal_access_status) job_result_code,
        job.action_type,job.created_at job_created_at,job.finished_at job_finished_at
      FROM tender.autopilot_queue job
      WHERE job.company_id=ANY($1::uuid[])
        AND job.credential_id IS NOT NULL
        AND job.action_type IN ('TEST_PORTAL_CONNECTION','TEST_DOCUMENT_FETCH','START_PORTAL_AUTHENTICATION')
      ORDER BY job.credential_id,job.company_id,job.created_at DESC,job.id DESC
    )
    SELECT company.company_id,company.legal_name,
      portal.id portal_id,portal.display_name portal_name,portal.portal_family_key,
      portal.canonical_domain,portal.adapter_id,portal.captcha_required,portal.mfa_required,
      credential.id credential_id,credential.version credential_version,
      credential.username_masked,credential.status credential_status,
      credential.revoked_at credential_revoked_at,credential.valid_until,
      credential.account_confirmed,credential.registration_status,credential.login_status,
      credential.mfa_required_state,credential.mfa_method,credential.bound_host,
      (credential.ciphertext IS NOT NULL AND credential.iv IS NOT NULL AND credential.auth_tag IS NOT NULL) encrypted_payload_complete,
      session.session_status,session.session_expires_at,session.last_verified_at,
      session.verification_status,session.session_effective_status,
      job.job_status,job.job_result_code,job.action_type latest_job_action,
      job.job_created_at,job.job_finished_at,
      count(DISTINCT assignment.tender_id)::int assigned_tenders,
      count(DISTINCT assignment.lot_id) FILTER (WHERE assignment.lot_id IS NOT NULL)::int assigned_lots
    FROM tender.portal_credential_companies scope
    JOIN tender.enterprise_company_links company ON company.company_id=scope.company_id AND company.active=true
    JOIN tender.portal_credential_secrets credential ON credential.id=scope.credential_id
    JOIN tender.portal_registry portal ON portal.id=credential.portal_id
    LEFT JOIN latest_session session ON session.credential_id=credential.id AND session.company_id=scope.company_id
    LEFT JOIN latest_job job ON job.credential_id=credential.id AND job.company_id=scope.company_id
    LEFT JOIN tender.tender_portal_assignments assignment
      ON assignment.portal_id=portal.id AND assignment.company_id=company.company_id
    WHERE scope.active=true AND company.company_id=ANY($1::uuid[])
    GROUP BY company.company_id,company.legal_name,portal.id,credential.id,
      session.credential_id,session.company_id,session.session_status,session.session_expires_at,
      session.last_verified_at,session.verification_status,session.session_effective_status,
      job.credential_id,job.company_id,job.job_status,job.job_result_code,job.action_type,
      job.job_created_at,job.job_finished_at
    ORDER BY company.legal_name,portal.canonical_domain,credential.version DESC
  `, [companyIds])).rows;

  const cleaningMatches = credentials.filter((row) =>
    row.legal_name === "WB-Cleaning GmbH" &&
    String(row.username_masked || "").toLowerCase() === "i***@wb-cleaning.gmbh");

  const credentialsWithCanonicalStatus = credentials.map((row) => ({
    ...row,
    canonical_status: canonicalPortalAccessStatus({
      configured: true,
      credentialStatus: row.credential_status,
      credentialRevokedAt: row.credential_revoked_at,
      credentialValidUntil: row.valid_until,
      loginStatus: row.login_status,
      sessionEffectiveStatus: row.session_effective_status,
      jobStatus: row.job_status,
      jobResultCode: row.job_result_code,
      mfaRequired: row.mfa_required_state === true,
      captchaRequired: row.captcha_required === true,
    }),
  }));

  const relevantMappings = (await pool.query(`
    SELECT company.legal_name,portal.id portal_id,portal.portal_family_key,portal.canonical_domain,
      count(DISTINCT assignment.tender_id)::int tenders,
      count(DISTINCT assignment.lot_id) FILTER(WHERE assignment.lot_id IS NOT NULL)::int lots,
      count(DISTINCT credential.id) FILTER(
        WHERE credential.status='ACTIVE' AND credential.revoked_at IS NULL
          AND (credential.valid_until IS NULL OR credential.valid_until>now())
      )::int active_credentials
    FROM tender.tender_portal_assignments assignment
    JOIN tender.enterprise_company_links company ON company.company_id=assignment.company_id AND company.active=true
    JOIN tender.portal_registry portal ON portal.id=assignment.portal_id
    LEFT JOIN tender.portal_credential_companies scope
      ON scope.company_id=company.company_id AND scope.active=true
    LEFT JOIN tender.portal_credential_secrets credential
      ON credential.id=scope.credential_id AND credential.portal_id=portal.id
    WHERE company.company_id=ANY($1::uuid[])
    GROUP BY company.legal_name,portal.id
    ORDER BY company.legal_name,portal.canonical_domain
  `, [companyIds])).rows;

  const exactScope = (await pool.query(`
    SELECT company.legal_name,
      count(*)::int assignments,
      count(*) FILTER(WHERE scope.credential_id IS NOT NULL)::int credential_ready,
      count(*) FILTER(WHERE scope.credential_id IS NULL)::int credential_not_ready
    FROM tender.current_tender_company_portal_role_scopes scope
    JOIN tender.enterprise_company_links company ON company.company_id=scope.company_id
    WHERE scope.company_id=ANY($1::uuid[]) AND scope.portal_role='DOCUMENT_PORTAL'
    GROUP BY company.legal_name ORDER BY company.legal_name
  `, [companyIds])).rows;

  const sharedCredentials = (await pool.query(`
    SELECT credential.id credential_id,portal.canonical_domain,
      count(DISTINCT scope.company_id)::int company_count,
      array_agg(DISTINCT company.legal_name ORDER BY company.legal_name) companies
    FROM tender.portal_credential_secrets credential
    JOIN tender.portal_credential_companies scope ON scope.credential_id=credential.id AND scope.active=true
    JOIN tender.enterprise_company_links company ON company.company_id=scope.company_id AND company.active=true
    JOIN tender.portal_registry portal ON portal.id=credential.portal_id
    WHERE scope.company_id=ANY($1::uuid[])
    GROUP BY credential.id,portal.canonical_domain
    HAVING count(DISTINCT scope.company_id)>1
    ORDER BY portal.canonical_domain,credential.id
  `, [companyIds])).rows;

  const statusCounts = Object.fromEntries(
    [...new Set(credentialsWithCanonicalStatus.map((row) => row.canonical_status))]
      .sort()
      .map((status) => [status, credentialsWithCanonicalStatus.filter((row) => row.canonical_status === status).length]),
  );
  const byCompany = companies.map((company) => {
    const rows = credentialsWithCanonicalStatus.filter((row) => row.company_id === company.company_id);
    return {
      companyId: company.company_id,
      legalName: company.legal_name,
      storedCredentialScopes: rows.length,
      canonicalStatuses: Object.fromEntries([...new Set(rows.map((row) => row.canonical_status))].sort().map((status) => [status, rows.filter((row) => row.canonical_status === status).length])),
      relevantPortalMappings: relevantMappings.filter((row) => row.legal_name === company.legal_name).length,
    };
  });

  const summary = {
    companies: companies.length,
    credentialScopes: credentials.length,
    relevantMappings: relevantMappings.length,
    exactDocumentScopes: exactScope,
    canonicalStatusCounts: statusCounts,
    sharedCredentialIds: sharedCredentials.length,
    sharedCredentials,
    exactCleaningMaskMatches: credentialsWithCanonicalStatus.filter((row) =>
      row.legal_name === "WB-Cleaning GmbH" && String(row.username_masked || "").toLowerCase() === "i***@wb-cleaning.gmbh"),
    byCompany,
  };

  console.log(JSON.stringify({
    readOnly: true,
    secretsSelected: false,
    capturedAt: new Date().toISOString(),
    companies,
    summary,
    credentialCount: credentials.length,
    credentials: process.env.SUMMARY_ONLY === "true" ? undefined : credentialsWithCanonicalStatus,
    exactCleaningMaskMatches: process.env.SUMMARY_ONLY === "true" ? undefined : cleaningMatches,
    mappingCount: relevantMappings.length,
    relevantMappings: process.env.SUMMARY_ONLY === "true" ? undefined : relevantMappings,
  }, null, 2));
} finally {
  await rawPool.end();
}
