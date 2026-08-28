\set ON_ERROR_STOP on

INSERT INTO tender.tender_lot_lifecycles(tender_id,lot_key,lifecycle_status,participation_status,
  offer_deadline,deadline_quality,is_current)
VALUES('00000000-0000-4000-8000-000000001231','LOT-STAGING-ROLLBACK','ACTIVE','ELIGIBLE',
  '2099-01-03T12:00:00Z','EXACT',true);

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM tender.lots WHERE tender_id='00000000-0000-4000-8000-000000001231' AND external_id='LOT-STAGING-ROLLBACK') THEN
    RAISE EXCEPTION 'down_migration_left_trigger_active';
  END IF;
  IF (SELECT count(*) FROM tender.lots WHERE tender_id='00000000-0000-4000-8000-000000001231')<>3 THEN
    RAISE EXCEPTION 'down_migration_changed_existing_productive_rows';
  END IF;
END $$;

SELECT 'canonical_lot_context_rollback_2_of_2' result;
