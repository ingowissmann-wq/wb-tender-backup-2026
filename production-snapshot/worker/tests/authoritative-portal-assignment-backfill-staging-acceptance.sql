\set ON_ERROR_STOP on

DO $$
BEGIN
  IF (SELECT count(*) FROM tender.tender_portal_assignments
      WHERE tenant_id='00000000-0000-4000-8000-000000001250'
        AND company_id='00000000-0000-4000-8000-000000001252'
        AND tender_id='00000000-0000-4000-8000-000000001231'
        AND source_lot_id='LOT-STAGING-1' AND status='ACTIVE'
        AND assignment_source='UNIQUE_EVIDENCE'
        AND portal_role='SUBMISSION_PORTAL')<>1 THEN
    RAISE EXCEPTION 'expected_exact_authoritative_submission_assignment';
  END IF;
  IF EXISTS(SELECT 1 FROM tender.current_tender_company_portal_role_scopes
      WHERE tender_id='00000000-0000-4000-8000-000000001231'
        AND source_lot_id='LOT-STAGING-1' AND credential_id IS NOT NULL) THEN
    RAISE EXCEPTION 'credential_must_not_be_synthesized';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.schema_migrations
      WHERE version='0129-authoritative-portal-assignment-backfill') THEN
    RAISE EXCEPTION 'migration_129_ledger_missing';
  END IF;
  IF EXISTS(SELECT 1 FROM tender.submission_contexts WHERE transmitted=true) THEN
    RAISE EXCEPTION 'submission_transmission_changed';
  END IF;
END $$;

SELECT 'authoritative_portal_assignment_backfill_4_of_4' result;
