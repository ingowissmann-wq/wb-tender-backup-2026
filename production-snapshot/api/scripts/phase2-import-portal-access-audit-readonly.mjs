import fs from "node:fs";
import pg from "pg";
import { createFixedScopedPool, loadBackgroundScope } from "../platform/scoped-pg-pool.mjs";

const connectionString = process.env.DATABASE_URL || fs.readFileSync(
  process.env.DATABASE_URL_FILE || "/run/secrets/database_url",
  "utf8",
).trim();
const rawPool = new pg.Pool({
  connectionString,
  max: 1,
  options: [
    "-c default_transaction_read_only=on -c statement_timeout=180000 -c lock_timeout=5000",
    process.env.DATABASE_SESSION_OPTIONS,
  ].filter(Boolean).join(" "),
});
const pool = createFixedScopedPool(rawPool, await loadBackgroundScope(rawPool)).pool;
const client = await pool.connect();
const query = async (sql, params = []) => (await client.query(sql, params)).rows;

try {
  await client.query("BEGIN READ ONLY");

  const scheduler = await query(`SELECT source.source_code,source.enabled,source.kill_switch,
      source.last_success_at,source.last_failure_at,source.next_run_at,
      latest.status latest_status,latest.started_at latest_started_at,latest.finished_at latest_finished_at,
      extract(epoch FROM (now()-source.last_success_at))::bigint last_success_age_seconds
    FROM tender.scheduler_sources source
    LEFT JOIN LATERAL(SELECT run.status,run.started_at,run.finished_at
      FROM tender.scheduler_runs run WHERE run.source_code=source.source_code
      ORDER BY run.started_at DESC,run.id DESC LIMIT 1) latest ON true
    WHERE source.source_code IN('TED','DOE') ORDER BY source.source_code`);

  const queue = await query(`SELECT job.status,coalesce(job.safe_error_code,job.error_code,'NO_ERROR_CODE') reason_code,count(*)::int count,
      count(*) FILTER(WHERE tender.data_class='PUBLIC_REAL' AND tender.source_lifecycle_status='ACTIVE'
        AND (tender.offer_deadline IS NULL OR tender.offer_deadline>now()))::int active_open,
      max(job.finished_at) latest_finished_at
    FROM tender.autopilot_queue job
    LEFT JOIN tender.tenders tender ON tender.id=job.tender_id
    WHERE job.status IN('FAILED','DEAD_LETTER','RETRY')
    GROUP BY job.status,coalesce(job.safe_error_code,job.error_code,'NO_ERROR_CODE') ORDER BY active_open DESC,count(*) DESC`);

  const companyScopes = await query(`SELECT company.company_id,company.legal_name,
      array_agg(DISTINCT scope.canonical_service ORDER BY scope.canonical_service) canonical_services,
      count(DISTINCT scope.tenant_id)::int tenant_count,
      count(DISTINCT scope.profile_id)::int profile_count,
      bool_and(scope.profile_id=company.tender_profile_id) authoritative_profile_binding,
      company.legal_name='WB-Protect & Service GmbH'
        AND array_agg(DISTINCT scope.canonical_service)=ARRAY['security']::text[] wb_protect_security_canonical
    FROM tender.enterprise_company_links company
    JOIN tender.configuration_scopes scope ON scope.company_id=company.company_id
    WHERE company.active=true
    GROUP BY company.company_id,company.legal_name ORDER BY company.legal_name`);

  const contextStatus = await query(`WITH current_relevance AS(
      SELECT DISTINCT ON(relevance.tender_id,relevance.company_id,coalesce(relevance.lot_key,''))
        relevance.tender_id,relevance.company_id,coalesce(relevance.lot_key,'') lot_key,
        relevance.service_line,relevance.relevance_status,relevance.service_scope_gate,
        relevance.evaluation_version
      FROM tender.current_service_relevance relevance
      WHERE relevance.relevance_status IN('RELEVANT','REVIEW_REQUIRED')
      ORDER BY relevance.tender_id,relevance.company_id,coalesce(relevance.lot_key,''),
        relevance.evaluation_version DESC
    ), real_context AS(
      SELECT relevance.*,company.legal_name,scope.tenant_id,scope.canonical_service,
        tender.source_code,tender.external_id,version.id tender_version_id,
        lot.id lot_id,coalesce(nullif(relevance.lot_key,''),lot.external_id) source_lot_id
      FROM current_relevance relevance
      JOIN tender.tenders tender ON tender.id=relevance.tender_id
        AND tender.data_class='PUBLIC_REAL' AND tender.source_lifecycle_status='ACTIVE'
        AND (tender.offer_deadline IS NULL OR tender.offer_deadline>now())
      JOIN tender.enterprise_company_links company ON company.company_id=relevance.company_id AND company.active=true
      JOIN tender.configuration_scopes scope ON scope.company_id=company.company_id
        AND scope.profile_id=company.tender_profile_id AND scope.canonical_service=relevance.service_line
      JOIN LATERAL(SELECT candidate.id FROM tender.tender_versions candidate
        WHERE candidate.tender_id=tender.id
        ORDER BY candidate.version DESC,candidate.created_at DESC,candidate.id DESC LIMIT 1) version ON true
      LEFT JOIN LATERAL(SELECT candidate.id,candidate.external_id FROM tender.lots candidate
        WHERE candidate.tender_id=tender.id
          AND (relevance.lot_key='' OR candidate.external_id=relevance.lot_key)
        ORDER BY candidate.external_id,candidate.id LIMIT 1) lot ON true
    ), required_role(portal_role,evidence_role) AS(VALUES
      ('DOCUMENT_PORTAL'::text,'PROCUREMENT_DOCUMENT'::text),
      ('BIDDER_PORTAL'::text,'PARTICIPATION'::text),
      ('SUBMISSION_PORTAL'::text,'SUBMISSION'::text)
    ), role_context AS(
      SELECT context.*,role.portal_role,role.evidence_role
      FROM real_context context CROSS JOIN required_role role
    ), resolution AS(
      SELECT context.tender_id,context.company_id,context.lot_key,context.portal_role,
        count(DISTINCT resolved.portal_id)::int portal_count,
        min(resolved.portal_id::text)::uuid portal_id,
        min(resolved.exact_host) exact_host,
        bool_and(resolved.resolution_status='UNIQUE_EVIDENCE') unique_evidence,
        array_agg(DISTINCT resolved.resolution_status ORDER BY resolved.resolution_status)
          FILTER(WHERE resolved.resolution_status IS NOT NULL) resolution_statuses
      FROM role_context context
      LEFT JOIN tender.tender_portal_resolutions resolved
        ON resolved.tender_id=context.tender_id AND resolved.tender_version_id=context.tender_version_id
        AND resolved.evidence_role=context.evidence_role
      GROUP BY context.tender_id,context.company_id,context.lot_key,context.portal_role
    ), classified AS(
      SELECT context.*,resolution.portal_count,resolution.portal_id,resolution.exact_host,
        resolution.unique_evidence,resolution.resolution_statuses,
        portal.canonical_domain,portal.portal_family_key,portal.adapter_id,
        capability.portal_type,
        assignment.id assignment_id,
        credential.candidate_count,credential.credential_id,credential.failure_reasons,
        session.effective_status,session.raw_status,session.mfa_pending,
        CASE
          WHEN resolution.portal_count=0 THEN 'PORTAL_ASSIGNMENT_REVIEW_REQUIRED'
          WHEN resolution.portal_count<>1 OR NOT coalesce(resolution.unique_evidence,false)
            THEN 'PORTAL_ASSIGNMENT_REVIEW_REQUIRED'
          WHEN portal.id IS NULL OR lower(portal.canonical_domain)<>lower(resolution.exact_host)
            THEN 'PORTAL_ASSIGNMENT_REVIEW_REQUIRED'
          WHEN capability.portal_type='BEKANNTMACHUNGSPLATTFORM' OR portal.adapter_id='ted-discovery'
            THEN 'PORTAL_ASSIGNMENT_REVIEW_REQUIRED'
          WHEN assignment.id IS NULL THEN 'PORTAL_ASSIGNMENT_REVIEW_REQUIRED'
          WHEN credential.candidate_count=1 THEN 'ACCESS_CONFIGURED'
          WHEN credential.candidate_count>1 THEN 'CREDENTIAL_ASSIGNMENT_REVIEW_REQUIRED'
          WHEN cardinality(coalesce(credential.failure_reasons,'{}'::text[]))>0
            THEN credential.failure_reasons[1]
          ELSE 'CREDENTIAL_MISSING'
        END access_status,
        CASE
          WHEN credential.candidate_count IS DISTINCT FROM 1 THEN 'NOT_APPLICABLE'
          WHEN session.effective_status='ACTIVE' THEN 'SESSION_ACTIVE'
          WHEN session.mfa_pending THEN 'MFA_REQUIRED'
          WHEN session.raw_status IS NOT NULL THEN 'REAUTH_REQUIRED'
          ELSE 'SESSION_MISSING'
        END session_status
      FROM role_context context
      JOIN resolution USING(tender_id,company_id,lot_key,portal_role)
      LEFT JOIN tender.portal_registry portal ON portal.id=resolution.portal_id
      LEFT JOIN tender.portal_capability_profiles capability ON capability.portal_id=portal.id
      LEFT JOIN LATERAL(SELECT candidate.id FROM tender.tender_portal_assignments candidate
        WHERE candidate.tenant_id=context.tenant_id AND candidate.company_id=context.company_id
          AND candidate.tender_id=context.tender_id AND candidate.tender_version_id=context.tender_version_id
          AND candidate.portal_role=context.portal_role AND candidate.status='ACTIVE'
          AND candidate.portal_id=resolution.portal_id
          AND lower(candidate.exact_host)=lower(resolution.exact_host)
          AND (candidate.source_lot_id IS NULL OR candidate.source_lot_id=context.source_lot_id)
        ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1) assignment ON true
      LEFT JOIN LATERAL(SELECT count(*) FILTER(WHERE exact_capable)::int candidate_count,
          min(id::text) FILTER(WHERE exact_capable)::uuid credential_id,
          array_agg(DISTINCT failure_reason ORDER BY failure_reason)
            FILTER(WHERE NOT exact_capable AND failure_reason IS NOT NULL) failure_reasons
        FROM (SELECT secret.id,
            secret.status='ACTIVE' AND secret.revoked_at IS NULL
              AND (secret.valid_until IS NULL OR secret.valid_until>now())
              AND company_scope.active
              AND (secret.bound_host IS NULL OR lower(secret.bound_host)=lower(resolution.exact_host))
              AND (secret.authorized_capabilities IS NULL OR CASE context.portal_role
                WHEN 'DOCUMENT_PORTAL' THEN secret.authorized_capabilities && ARRAY['AUTHENTICATED_DOCUMENT_ACCESS','TENDER_DOCUMENT_DOWNLOAD']::text[]
                WHEN 'BIDDER_PORTAL' THEN 'BIDDER_LOGIN'=ANY(secret.authorized_capabilities)
                WHEN 'SUBMISSION_PORTAL' THEN 'BID_SUBMISSION'=ANY(secret.authorized_capabilities)
                ELSE false END) exact_capable,
            CASE
              WHEN secret.status<>'ACTIVE' OR secret.revoked_at IS NOT NULL
                OR (secret.valid_until IS NOT NULL AND secret.valid_until<=now()) THEN 'CREDENTIAL_EXPIRED_OR_INACTIVE'
              WHEN NOT company_scope.active THEN 'CREDENTIAL_COMPANY_BINDING_INACTIVE'
              WHEN secret.bound_host IS NOT NULL AND lower(secret.bound_host)<>lower(resolution.exact_host)
                THEN 'CREDENTIAL_HOST_MISMATCH'
              WHEN secret.authorized_capabilities IS NOT NULL AND NOT CASE context.portal_role
                WHEN 'DOCUMENT_PORTAL' THEN secret.authorized_capabilities && ARRAY['AUTHENTICATED_DOCUMENT_ACCESS','TENDER_DOCUMENT_DOWNLOAD']::text[]
                WHEN 'BIDDER_PORTAL' THEN 'BIDDER_LOGIN'=ANY(secret.authorized_capabilities)
                WHEN 'SUBMISSION_PORTAL' THEN 'BID_SUBMISSION'=ANY(secret.authorized_capabilities)
                ELSE false END THEN 'CREDENTIAL_CAPABILITY_MISMATCH'
              ELSE NULL END failure_reason
          FROM tender.portal_credential_secrets secret
          JOIN tender.portal_credential_companies company_scope
            ON company_scope.credential_id=secret.id AND company_scope.company_id=context.company_id
          WHERE secret.portal_id=resolution.portal_id) candidate) credential ON true
      LEFT JOIN LATERAL(SELECT
          tender.portal_session_effective_status(saved.status,saved.expires_at,saved.revoked_at,saved.verification_status) effective_status,
          saved.status raw_status,
          EXISTS(SELECT 1 FROM tender.portal_login_continuations continuation
            WHERE continuation.portal_id=resolution.portal_id
              AND continuation.credential_id=credential.credential_id
              AND continuation.company_id=context.company_id
              AND continuation.status='MFA_REQUIRED') mfa_pending
        FROM tender.portal_read_sessions saved
        WHERE saved.portal_id=resolution.portal_id AND saved.credential_id=credential.credential_id
          AND saved.company_id=context.company_id
        ORDER BY saved.created_at DESC,saved.id DESC LIMIT 1) session ON true
    ) SELECT legal_name,canonical_service,source_code,portal_role,
      coalesce(portal_family_key,'<UNRESOLVED>') portal_family,
      coalesce(access_status,'PORTAL_ASSIGNMENT_REVIEW_REQUIRED') access_status,
      coalesce(session_status,'NOT_APPLICABLE') session_status,
      count(*)::int real_contexts,
      count(DISTINCT tender_id)::int real_tenders,
      count(*) FILTER(WHERE assignment_id IS NOT NULL)::int assigned_contexts,
      count(*) FILTER(WHERE credential_id IS NOT NULL)::int credential_bound_contexts
    FROM classified
    GROUP BY legal_name,canonical_service,source_code,portal_role,
      coalesce(portal_family_key,'<UNRESOLVED>'),access_status,session_status
    ORDER BY legal_name,portal_role,portal_family,access_status,session_status`);

  const tedRoleSeparation = await query(`WITH latest AS(
      SELECT DISTINCT ON(version.tender_id) version.tender_id,version.id tender_version_id
      FROM tender.tender_versions version ORDER BY version.tender_id,version.version DESC,version.created_at DESC,version.id DESC
    ) SELECT resolution.evidence_role,resolution.resolution_status,count(*)::int count,
      count(*) FILTER(WHERE portal.adapter_id='ted-discovery')::int ted_as_resolved_portal,
      count(*) FILTER(WHERE tender.source_code='TED' AND portal.adapter_id<>'ted-discovery')::int ted_notice_external_portal
    FROM latest JOIN tender.tender_portal_resolutions resolution USING(tender_id,tender_version_id)
    JOIN tender.tenders tender ON tender.id=latest.tender_id AND tender.data_class='PUBLIC_REAL'
    LEFT JOIN tender.portal_registry portal ON portal.id=resolution.portal_id
    GROUP BY resolution.evidence_role,resolution.resolution_status
    ORDER BY resolution.evidence_role,resolution.resolution_status`);

  const credentialIsolation = await query(`SELECT
      count(*)::int credential_rows,
      count(*) FILTER(WHERE ciphertext IS NOT NULL AND iv IS NOT NULL AND auth_tag IS NOT NULL)::int encrypted_rows,
      count(*) FILTER(WHERE status='ACTIVE' AND revoked_at IS NULL)::int active_rows,
      count(*) FILTER(WHERE status='ACTIVE' AND (bound_host IS NULL OR authorized_capabilities IS NULL))::int active_legacy_untyped,
      count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM tender.portal_credential_companies binding
        WHERE binding.credential_id=secret.id AND binding.active))::int active_without_company_binding,
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM tender.portal_credential_companies left_binding
        JOIN tender.portal_credential_companies right_binding ON right_binding.credential_id=left_binding.credential_id
          AND right_binding.company_id<>left_binding.company_id AND right_binding.active
        WHERE left_binding.credential_id=secret.id AND left_binding.active))::int shared_across_companies
    FROM tender.portal_credential_secrets secret`);

  const documents = await query(`SELECT
      count(*) FILTER(WHERE document.procurement_relevant)::int relevant,
      count(*) FILTER(WHERE document.procurement_relevant AND document.content IS NOT NULL
        AND document.payload_sha256 IS NOT NULL)::int payload_present,
      count(*) FILTER(WHERE document.procurement_relevant AND document.magic_bytes_verified)::int magic_verified,
      count(*) FILTER(WHERE document.procurement_relevant
        AND scan.status='CLEAN')::int malware_clean,
      count(*) FILTER(WHERE document.procurement_relevant
        AND document.procurement_verification_status='VERIFIED')::int procurement_verified,
      count(*) FILTER(WHERE document.procurement_relevant AND document.lot_id IS NULL)::int tender_global,
      count(DISTINCT document.payload_sha256) FILTER(WHERE document.procurement_relevant)::int unique_payloads,
      count(*) FILTER(WHERE document.procurement_relevant AND document.resolution_status='PORTAL_ACCESS_REQUIRED')::int access_required
    FROM tender.enrichment_documents document
    LEFT JOIN LATERAL(SELECT candidate.status FROM tender.document_malware_scans candidate
      WHERE candidate.document_id=document.id
        AND candidate.payload_sha256=document.payload_sha256
      ORDER BY candidate.scanned_at DESC,candidate.id DESC LIMIT 1) scan ON true`);

  const runtimeContracts = await query(`SELECT current_user runtime_role,
      has_table_privilege(current_user,'tender.tender_external_links','SELECT,INSERT,UPDATE') external_link_write,
      has_table_privilege(current_user,'tender.tender_portal_resolutions','SELECT,INSERT,UPDATE') resolution_write,
      has_table_privilege(current_user,'tender.tender_portal_assignments','SELECT,INSERT,UPDATE') assignment_write,
      (SELECT is_nullable='YES' FROM information_schema.columns
        WHERE table_schema='tender' AND table_name='autopilot_queue' AND column_name='company_id') queue_company_nullable,
      (SELECT is_nullable='YES' FROM information_schema.columns
        WHERE table_schema='tender' AND table_name='autopilot_queue' AND column_name='lot_key') queue_lot_nullable,
      (SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY conname)
        FROM pg_constraint WHERE conrelid='tender.tender_portal_resolutions'::regclass) resolution_constraints`);

  await client.query("ROLLBACK");
  console.log(JSON.stringify({
    capturedAt: new Date().toISOString(),
    transaction: "READ_ONLY_ROLLED_BACK",
    scheduler,
    queue,
    companyScopes,
    contextStatus,
    tedRoleSeparation,
    credentialIsolation,
    documents,
    runtimeContracts,
    externalWrite: false,
    transmitted: false,
  }, null, 2));
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.release();
  await rawPool.end();
}
