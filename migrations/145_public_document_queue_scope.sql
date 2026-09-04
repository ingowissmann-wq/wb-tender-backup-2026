BEGIN;
SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:public-document-queue-scope:145',0));

CREATE OR REPLACE FUNCTION tender.reject_unscoped_portal_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE credential_scope_valid boolean; public_read_scope_valid boolean;
BEGIN
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
          AND portal.adapter_enabled=true AND portal.adapter_validation_status IN('VALIDATED','VALIDATED_READ_ONLY')
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

INSERT INTO tender.audit_events(action,metadata) VALUES('PUBLIC_DOCUMENT_QUEUE_SCOPE_GUARD_INSTALLED',jsonb_build_object(
  'release','20260826-public-document-queue-scope-145.1','credentiallessActions',jsonb_build_array(
    'RUN_FULL_PIPELINE','DOWNLOAD_DOCUMENTS','FETCH_DOCUMENTS','ANALYZE_DOCUMENTS','REFRESH_ENRICHMENT'),
  'requiredEvidence','UNIQUE_CURRENT_PROCUREMENT_DOCUMENT_PORTAL_WITH_VALIDATED_PUBLIC_READ_CAPABILITY',
  'loginBypass',false,'submissionBypass',false,'externalWrite',false,'externalSubmission',false,'transmitted',false));
INSERT INTO app.schema_migrations(version,description) VALUES('0145-public-document-queue-scope',
  'Permit credentialless internal read processing only for exact current validated public procurement-document portals')
ON CONFLICT(version) DO NOTHING;
COMMIT;
