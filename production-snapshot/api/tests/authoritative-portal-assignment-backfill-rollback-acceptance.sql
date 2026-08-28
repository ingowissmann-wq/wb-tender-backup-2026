\set ON_ERROR_STOP on

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM app.schema_migrations
      WHERE version='0129-authoritative-portal-assignment-backfill') THEN
    RAISE EXCEPTION 'migration_129_ledger_not_removed';
  END IF;
  IF (SELECT count(*) FROM tender.tender_portal_assignments
      WHERE tender_id='00000000-0000-4000-8000-000000001231'
        AND source_lot_id='LOT-STAGING-1' AND status='ACTIVE'
        AND assignment_source='UNIQUE_EVIDENCE'
        AND portal_role='SUBMISSION_PORTAL')<>1 THEN
    RAISE EXCEPTION 'authoritative_assignments_lost_on_expand_only_rollback';
  END IF;
  IF EXISTS(SELECT 1 FROM tender.submission_contexts WHERE transmitted=true) THEN
    RAISE EXCEPTION 'submission_transmission_changed';
  END IF;
END $$;

SELECT 'authoritative_portal_assignment_rollback_3_of_3' result;
