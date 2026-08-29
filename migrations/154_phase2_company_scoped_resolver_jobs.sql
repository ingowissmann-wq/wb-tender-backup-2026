BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:migration:154-phase2-company-scoped-resolver',0));

CREATE OR REPLACE FUNCTION tender.reject_unscoped_portal_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE credential_scope_valid boolean:=false; public_read_scope_valid boolean:=false; resolution_scope_valid boolean:=false;
BEGIN
  IF NEW.action_type='RESOLVE_NOTICE_PORTALS' THEN
    resolution_scope_valid:=NEW.tender_id IS NOT NULL AND NEW.tender_version_id IS NOT NULL
      AND NEW.company_id IS NOT NULL AND NEW.lot_key IS NULL AND NEW.portal_id IS NULL AND NEW.credential_id IS NULL
      AND EXISTS(SELECT 1 FROM tender.tender_versions version
        WHERE version.id=NEW.tender_version_id AND version.tender_id=NEW.tender_id
          AND version.id=(SELECT current_version.id FROM tender.tender_versions current_version
            WHERE current_version.tender_id=NEW.tender_id
            ORDER BY current_version.version DESC,current_version.created_at DESC,current_version.id DESC LIMIT 1))
      AND EXISTS(SELECT 1 FROM tender.current_service_relevance relevance
        JOIN tender.enterprise_company_links company ON company.company_id=relevance.company_id AND company.active=true
        WHERE relevance.tender_id=NEW.tender_id AND relevance.company_id=NEW.company_id
          AND relevance.primary_company=true
          AND relevance.relevance_status IN('RELEVANT','REVIEW_REQUIRED'));
    IF NOT resolution_scope_valid THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='current_company_notice_resolution_scope_required';
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

INSERT INTO tender.audit_events(action,metadata) VALUES('PHASE2_COMPANY_SCOPED_RESOLVER_GUARD_INSTALLED',jsonb_build_object(
  'release','20260826-phase2-company-scoped-resolver-154.1','rls122Preserved',true,
  'companyScopeRequired',true,'externalWrite',false,'externalSubmission',false,'transmitted',false));
INSERT INTO app.schema_migrations(version,description) VALUES('0154-phase2-company-scoped-resolver-jobs',
  'Bind notice resolver jobs to an exact active company so queue RLS 122 remains fail closed')
ON CONFLICT(version) DO NOTHING;
COMMIT;
