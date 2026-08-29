BEGIN;
SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';

-- Preserve resolver job evidence and the additive enum value. Release 152.2
-- does not execute the new action after all unstarted jobs are soft-cancelled.
UPDATE tender.autopilot_queue SET status='CANCELLED',current_step='ROLLBACK_SOFT_CANCELLED',
  finished_at=coalesce(finished_at,now()),terminal_at=coalesce(terminal_at,now()),
  terminal_result='APPLICATION_ROLLBACK',heartbeat_at=now()
WHERE action_type='RESOLVE_NOTICE_PORTALS' AND status IN('PENDING','QUEUED','RETRY');

CREATE OR REPLACE VIEW tender.current_tender_company_portal_role_scopes
WITH (security_barrier=true,security_invoker=true) AS
WITH current_assignment AS(
  SELECT assignment.*
  FROM tender.tender_portal_assignments assignment
  JOIN tender.enterprise_company_links company ON company.company_id=assignment.company_id AND company.active=true
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
    AND credential.bound_host=lower(assignment.exact_host)
    AND CASE assignment.portal_role
      WHEN 'DOCUMENT_PORTAL' THEN credential.authorized_capabilities && ARRAY[
        'AUTHENTICATED_DOCUMENT_ACCESS','TENDER_DOCUMENT_DOWNLOAD']::text[]
      WHEN 'SUBMISSION_PORTAL' THEN 'BID_SUBMISSION'=ANY(coalesce(credential.authorized_capabilities,'{}'::text[]))
      WHEN 'BIDDER_PORTAL' THEN 'BIDDER_LOGIN'=ANY(coalesce(credential.authorized_capabilities,'{}'::text[]))
      ELSE credential.authorized_capabilities && ARRAY['BIDDER_LOGIN','TENDER_DOCUMENT_DOWNLOAD','BID_SUBMISSION']::text[]
    END
  JOIN tender.portal_credential_companies company_scope
    ON company_scope.credential_id=credential.id AND company_scope.company_id=assignment.company_id
      AND company_scope.active=true
  GROUP BY assignment.id HAVING count(DISTINCT credential.id)=1
)
SELECT assignment.id assignment_id,assignment.tenant_id,assignment.company_id,
  assignment.tender_id,assignment.tender_version_id,assignment.lot_id,assignment.source_lot_id,
  assignment.canonical_service,assignment.portal_role,assignment.portal_id,assignment.exact_host,
  credential.credential_id,credential.active_credential_count,assignment.assignment_source,
  assignment.evidence_sha256,assignment.created_at
FROM current_assignment assignment
LEFT JOIN capable_credentials credential ON credential.assignment_id=assignment.id;

-- Application-first rollback to the exact release-152.2 queue guard. No
-- portal evidence, credentials, sessions, documents, jobs or assignments are deleted.
CREATE OR REPLACE FUNCTION tender.reject_unscoped_portal_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE credential_scope_valid boolean; public_read_scope_valid boolean;
BEGIN
  IF NEW.action_type='RESOLVE_NOTICE_PORTALS' THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='notice_resolution_disabled_by_application_rollback';
  END IF;
  IF NEW.action_type IN('TEST_LOGIN','TEST_DOCUMENT_FETCH','RUN_FULL_PIPELINE','DOWNLOAD_DOCUMENTS',
      'FETCH_DOCUMENTS','ANALYZE_DOCUMENTS','REFRESH_ENRICHMENT') THEN
    credential_scope_valid:=NEW.company_id IS NOT NULL AND NEW.tender_id IS NOT NULL AND EXISTS(
      SELECT 1 FROM tender.current_registered_tender_company_portals scope
      WHERE scope.tender_id=NEW.tender_id AND scope.company_id=NEW.company_id
        AND (NEW.portal_id IS NULL OR scope.portal_id=NEW.portal_id));
    public_read_scope_valid:=NEW.action_type IN('RUN_FULL_PIPELINE','DOWNLOAD_DOCUMENTS','FETCH_DOCUMENTS','ANALYZE_DOCUMENTS','REFRESH_ENRICHMENT')
      AND NEW.company_id IS NOT NULL AND NEW.tender_id IS NOT NULL AND NEW.portal_id IS NOT NULL AND NEW.credential_id IS NULL
      AND EXISTS(SELECT 1 FROM tender.tender_portal_resolutions resolution
        JOIN tender.portal_registry portal ON portal.id=resolution.portal_id
          AND portal.adapter_enabled=true
          AND portal.adapter_validation_status IN('VALIDATED','VALIDATED_READ_ONLY','PRODUCTION_VALIDATED')
          AND 'PUBLIC_DOCUMENTS_POSSIBLE'=ANY(coalesce(portal.capabilities,'{}'::text[]))
        JOIN LATERAL(SELECT version.id FROM tender.tender_versions version WHERE version.tender_id=resolution.tender_id
          ORDER BY version.version DESC,version.created_at DESC,version.id DESC LIMIT 1)latest ON latest.id=resolution.tender_version_id
        WHERE resolution.tender_id=NEW.tender_id AND resolution.portal_id=NEW.portal_id
          AND resolution.evidence_role='PROCUREMENT_DOCUMENT' AND resolution.resolution_status='UNIQUE_EVIDENCE'
          AND EXISTS(SELECT 1 FROM tender.tender_external_links link WHERE link.tender_id=resolution.tender_id
            AND link.role='PROCUREMENT_DOCUMENT' AND link.public_access=true
            AND link.verification_status IN('DISCOVERED','HTTP_VERIFIED')
            AND lower(coalesce(link.final_host,link.original_host))=lower(portal.canonical_domain)));
    IF NOT credential_scope_valid AND NOT public_read_scope_valid THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='registered_portal_scope_required_before_enqueue';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DELETE FROM app.schema_migrations WHERE version='0153-phase2-authoritative-portal-jobs';
COMMIT;
