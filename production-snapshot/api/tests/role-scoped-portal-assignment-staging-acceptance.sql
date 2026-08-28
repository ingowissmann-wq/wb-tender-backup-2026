BEGIN;

INSERT INTO tender.portal_registry(id,display_name,canonical_domain,adapter_id,adapter_version,
  adapter_validation_status,adapter_enabled,capabilities)
VALUES('00000000-0000-4000-8000-000000001260','Context 126 Portal','context-126.example',
  'context-126','1.0.0','PRODUCTION_VALIDATED',true,
  ARRAY['AUTHENTICATED_DOCUMENT_ACCESS','TENDER_DOCUMENT_DOWNLOAD','BID_SUBMISSION']::text[]);

INSERT INTO tender.tender_portal_assignments(tenant_id,company_id,tender_id,tender_version_id,
  lot_id,source_lot_id,canonical_service,portal_id,exact_host,portal_role,assignment_source,
  evidence_sha256,status)
SELECT '00000000-0000-4000-8000-000000001250','00000000-0000-4000-8000-000000001252',
  '00000000-0000-4000-8000-000000001231','00000000-0000-4000-8000-000000001255',
  lot.id,'LOT-STAGING-1','security','00000000-0000-4000-8000-000000001260',
  'context-126.example',role,'MANUAL_AUDITED',repeat(CASE role
    WHEN 'DOCUMENT_PORTAL' THEN 'a' ELSE 'b' END,64),'ACTIVE'
FROM tender.lots lot CROSS JOIN (VALUES('DOCUMENT_PORTAL'),('SUBMISSION_PORTAL')) role_set(role)
WHERE lot.tender_id='00000000-0000-4000-8000-000000001231' AND lot.external_id='LOT-STAGING-1';

DO $$
DECLARE role_count int;
BEGIN
  SELECT count(*) INTO role_count FROM tender.current_tender_company_portal_role_scopes
  WHERE tenant_id='00000000-0000-4000-8000-000000001250'
    AND company_id='00000000-0000-4000-8000-000000001252'
    AND tender_id='00000000-0000-4000-8000-000000001231'
    AND source_lot_id='LOT-STAGING-1';
  IF role_count<>2 THEN RAISE EXCEPTION 'expected_two_independent_role_scopes_got_%',role_count; END IF;
  IF EXISTS(SELECT 1 FROM tender.current_tender_company_portal_role_scopes
    WHERE tender_id='00000000-0000-4000-8000-000000001231' AND credential_id IS NOT NULL) THEN
    RAISE EXCEPTION 'unproven_credential_must_not_be_synthesized';
  END IF;
  BEGIN
    INSERT INTO tender.tender_portal_assignments(tenant_id,company_id,tender_id,tender_version_id,
      lot_id,source_lot_id,canonical_service,portal_id,exact_host,portal_role,assignment_source,
      evidence_sha256,status)
    SELECT '00000000-0000-4000-8000-000000001250','00000000-0000-4000-8000-000000001252',
      '00000000-0000-4000-8000-000000001231','00000000-0000-4000-8000-000000001255',
      lot.id,'LOT-STAGING-1','security','00000000-0000-4000-8000-000000001260',
      'context-126.example','DOCUMENT_PORTAL','MANUAL_AUDITED',repeat('c',64),'ACTIVE'
    FROM tender.lots lot WHERE lot.tender_id='00000000-0000-4000-8000-000000001231'
      AND lot.external_id='LOT-STAGING-1';
    RAISE EXCEPTION 'duplicate_active_role_scope_was_accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

ROLLBACK;
