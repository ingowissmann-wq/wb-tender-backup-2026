BEGIN;
SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:phase2-authoritative-portal-jobs:153',0));

ALTER TABLE tender.autopilot_queue DROP CONSTRAINT IF EXISTS autopilot_queue_action_type_phase2_check;
ALTER TABLE tender.autopilot_queue ADD CONSTRAINT autopilot_queue_action_type_phase2_check CHECK(action_type IN(
  'TEST_PORTAL_CONNECTION','TEST_DOCUMENT_FETCH','RESOLVE_TARGET_PORTAL','VALIDATE_PORTAL_ADAPTER',
  'FETCH_DOCUMENTS','ANALYZE_DOCUMENTS','REFRESH_ENRICHMENT','VALIDATE_CALCULATION_INPUTS',
  'START_CALCULATION','REFRESH_REVIEW','GENERATE_RECOMMENDATION','RUN_FULL_PIPELINE',
  'GENERATE_BOARD_REPORT','EXPORT_REVIEW_REPORT','EXPORT_BOARD_BRIEF','START_PORTAL_AUTHENTICATION',
  'RESOLVE_NOTICE_PORTALS'
)) NOT VALID;
ALTER TABLE tender.autopilot_queue VALIDATE CONSTRAINT autopilot_queue_action_type_phase2_check;
ALTER TABLE tender.autopilot_queue DROP CONSTRAINT autopilot_queue_action_type_check;
ALTER TABLE tender.autopilot_queue RENAME CONSTRAINT autopilot_queue_action_type_phase2_check TO autopilot_queue_action_type_check;

CREATE OR REPLACE VIEW tender.current_tender_company_portal_role_scopes
WITH (security_barrier=true,security_invoker=true) AS
WITH current_assignment AS(
  SELECT assignment.*
  FROM tender.tender_portal_assignments assignment
  JOIN tender.enterprise_company_links company
    ON company.company_id=assignment.company_id AND company.active=true
  JOIN saas.legacy_company_tenant_bindings company_tenant
    ON company_tenant.company_id=assignment.company_id AND company_tenant.tenant_id=assignment.tenant_id
  JOIN tender.portal_registry portal ON portal.id=assignment.portal_id
    AND lower(portal.canonical_domain)=lower(assignment.exact_host)
  JOIN LATERAL(SELECT version.id FROM tender.tender_versions version
    WHERE version.tender_id=assignment.tender_id
    ORDER BY version.version DESC,version.created_at DESC,version.id DESC LIMIT 1) latest_version
    ON latest_version.id=assignment.tender_version_id
  LEFT JOIN tender.lots lot ON lot.id=assignment.lot_id
    AND lot.tender_id=assignment.tender_id AND lot.external_id=assignment.source_lot_id
  WHERE assignment.status='ACTIVE'
    AND ((assignment.lot_id IS NULL AND assignment.source_lot_id IS NULL) OR lot.id IS NOT NULL)
), capable_credentials AS(
  SELECT assignment.id assignment_id,count(DISTINCT credential.id)::int active_credential_count,
    min(credential.id::text)::uuid credential_id
  FROM current_assignment assignment
  JOIN tender.portal_credential_secrets credential ON credential.portal_id=assignment.portal_id
    AND credential.status='ACTIVE' AND credential.revoked_at IS NULL
    AND (credential.valid_until IS NULL OR credential.valid_until>now())
  JOIN tender.portal_credential_companies company_scope
    ON company_scope.credential_id=credential.id AND company_scope.company_id=assignment.company_id
      AND company_scope.active=true
  WHERE NOT EXISTS(SELECT 1 FROM tender.portal_credential_companies other_scope
      WHERE other_scope.credential_id=credential.id AND other_scope.active=true
        AND other_scope.company_id<>assignment.company_id)
    AND (credential.account_type IS NULL OR (
      credential.bound_host=lower(assignment.exact_host)
      AND CASE assignment.portal_role
        WHEN 'DOCUMENT_PORTAL' THEN credential.authorized_capabilities && ARRAY[
          'AUTHENTICATED_DOCUMENT_ACCESS','TENDER_DOCUMENT_DOWNLOAD']::text[]
        WHEN 'SUBMISSION_PORTAL' THEN 'BID_SUBMISSION'=ANY(coalesce(credential.authorized_capabilities,'{}'::text[]))
        WHEN 'BIDDER_PORTAL' THEN 'BIDDER_LOGIN'=ANY(coalesce(credential.authorized_capabilities,'{}'::text[]))
        ELSE credential.authorized_capabilities && ARRAY['BIDDER_LOGIN','TENDER_DOCUMENT_DOWNLOAD','BID_SUBMISSION']::text[]
      END))
  GROUP BY assignment.id HAVING count(DISTINCT credential.id)=1
)
SELECT assignment.id assignment_id,assignment.tenant_id,assignment.company_id,
  assignment.tender_id,assignment.tender_version_id,assignment.lot_id,assignment.source_lot_id,
  assignment.canonical_service,assignment.portal_role,assignment.portal_id,assignment.exact_host,
  credential.credential_id,credential.active_credential_count,assignment.assignment_source,
  assignment.evidence_sha256,assignment.created_at
FROM current_assignment assignment
LEFT JOIN capable_credentials credential ON credential.assignment_id=assignment.id;

COMMENT ON VIEW tender.current_tender_company_portal_role_scopes IS
  'Exact current role scope. Single-company legacy credentials retain compatibility; shared credentials and typed capability mismatches fail closed.';

CREATE OR REPLACE FUNCTION tender.reject_unscoped_portal_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE credential_scope_valid boolean:=false; public_read_scope_valid boolean:=false; resolution_scope_valid boolean:=false;
BEGIN
  IF NEW.action_type='RESOLVE_NOTICE_PORTALS' THEN
    resolution_scope_valid:=NEW.tender_id IS NOT NULL AND NEW.tender_version_id IS NOT NULL
      AND NEW.company_id IS NULL AND NEW.lot_key IS NULL AND NEW.portal_id IS NULL AND NEW.credential_id IS NULL
      AND EXISTS(SELECT 1 FROM tender.tender_versions version
        WHERE version.id=NEW.tender_version_id AND version.tender_id=NEW.tender_id
          AND version.id=(SELECT current_version.id FROM tender.tender_versions current_version
            WHERE current_version.tender_id=NEW.tender_id
            ORDER BY current_version.version DESC,current_version.created_at DESC,current_version.id DESC LIMIT 1));
    IF NOT resolution_scope_valid THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='current_notice_resolution_scope_required';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.action_type IN('TEST_LOGIN','TEST_DOCUMENT_FETCH','RUN_FULL_PIPELINE','DOWNLOAD_DOCUMENTS',
      'FETCH_DOCUMENTS','ANALYZE_DOCUMENTS','REFRESH_ENRICHMENT') THEN
    credential_scope_valid:=NEW.company_id IS NOT NULL AND NEW.tender_id IS NOT NULL
      AND NEW.portal_id IS NOT NULL AND NEW.credential_id IS NOT NULL AND NEW.lot_key IS NOT NULL
      AND EXISTS(SELECT 1 FROM tender.current_tender_company_portal_role_scopes scope
        WHERE scope.tender_id=NEW.tender_id AND scope.company_id=NEW.company_id
          AND scope.source_lot_id=NEW.lot_key AND scope.portal_id=NEW.portal_id
          AND scope.credential_id=NEW.credential_id
          AND (scope.portal_role='DOCUMENT_PORTAL' OR NEW.action_type<>ALL(ARRAY[
            'TEST_DOCUMENT_FETCH','RUN_FULL_PIPELINE','DOWNLOAD_DOCUMENTS','FETCH_DOCUMENTS','ANALYZE_DOCUMENTS'
          ]::text[])));
    public_read_scope_valid:=NEW.action_type IN('RUN_FULL_PIPELINE','DOWNLOAD_DOCUMENTS','FETCH_DOCUMENTS','ANALYZE_DOCUMENTS','REFRESH_ENRICHMENT')
      AND NEW.company_id IS NOT NULL AND NEW.tender_id IS NOT NULL AND NEW.portal_id IS NOT NULL
      AND NEW.credential_id IS NULL AND NEW.lot_key IS NOT NULL
      AND EXISTS(SELECT 1 FROM tender.current_tender_company_portal_role_scopes scope
        JOIN tender.portal_registry portal ON portal.id=scope.portal_id
          AND portal.adapter_enabled=true AND portal.adapter_validation_status='PRODUCTION_VALIDATED'
          AND 'PUBLIC_DOCUMENTS_POSSIBLE'=ANY(coalesce(portal.capabilities,'{}'::text[]))
        WHERE scope.tender_id=NEW.tender_id AND scope.company_id=NEW.company_id
          AND scope.source_lot_id=NEW.lot_key AND scope.portal_id=NEW.portal_id
          AND scope.portal_role='DOCUMENT_PORTAL'
          AND EXISTS(SELECT 1 FROM tender.tender_external_links link
            WHERE link.tender_id=scope.tender_id AND link.tender_version_id=scope.tender_version_id
              AND link.role='PROCUREMENT_DOCUMENT' AND link.public_access=true
              AND link.verification_status IN('DISCOVERED','HTTP_VERIFIED')
              AND (lower(coalesce(link.final_host,link.original_host))=lower(portal.canonical_domain)
                OR lower(coalesce(link.final_host,link.original_host))=ANY(portal.allowed_subdomains)
                OR lower(coalesce(link.final_host,link.original_host))=ANY(portal.download_domains))));
    IF NOT credential_scope_valid AND NOT public_read_scope_valid THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='exact_role_company_lot_portal_scope_required_before_enqueue';
    END IF;
  END IF;
  RETURN NEW;
END $$;

INSERT INTO tender.audit_events(action,metadata) VALUES('PHASE2_AUTHORITATIVE_PORTAL_JOB_GUARD_INSTALLED',jsonb_build_object(
  'release','20260826-phase2-authoritative-portal-jobs-153.1','noticeResolutionReadOnly',true,
  'exactRoleCompanyLotCredentialScope',true,'submissionBypass',false,'externalWrite',false,
  'externalSubmission',false,'transmitted',false));
INSERT INTO app.schema_migrations(version,description) VALUES('0153-phase2-authoritative-portal-jobs',
  'Permit read-only source portal resolution and enforce exact role/company/lot scope for document continuation')
ON CONFLICT(version) DO NOTHING;
COMMIT;
