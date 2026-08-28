\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM tender.lots WHERE tender_id='00000000-0000-4000-8000-000000001231' AND external_id='LOT-STAGING-1') THEN
    RAISE EXCEPTION 'backfill_did_not_materialize_canonical_lot';
  END IF;
  IF (SELECT (before_counts->>'current_lifecycles_without_canonical_lot')::int
      FROM tender.context_backfill_runs WHERE release_id='20260825-canonical-lot-context-continuity-123.1')<>1 THEN
    RAISE EXCEPTION 'before_count_not_evidenced';
  END IF;
  IF (SELECT (after_counts->>'current_lifecycles_without_canonical_lot')::int
      FROM tender.context_backfill_runs WHERE release_id='20260825-canonical-lot-context-continuity-123.1')<>0 THEN
    RAISE EXCEPTION 'after_count_not_zero';
  END IF;
END $$;

INSERT INTO tender.tender_lot_lifecycles(tender_id,lot_key,lifecycle_status,participation_status,
  offer_deadline,deadline_quality,is_current)
VALUES('00000000-0000-4000-8000-000000001231','LOT-STAGING-2','ACTIVE','ELIGIBLE',
  '2099-01-02T12:00:00Z','EXACT',true);

DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM tender.lots WHERE tender_id='00000000-0000-4000-8000-000000001231' AND external_id='LOT-STAGING-2') THEN
    RAISE EXCEPTION 'trigger_did_not_materialize_future_canonical_lot';
  END IF;
END $$;

SELECT 'canonical_lot_context_staging_4_of_4' result;
