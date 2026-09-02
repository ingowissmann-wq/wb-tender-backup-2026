BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:migration:162-selected-lot-region-invariant',0));

DROP TRIGGER IF EXISTS tender_lot_selection_region_recalculation
ON tender.tender_lot_selections;

DROP FUNCTION IF EXISTS tender.enqueue_region_recalculation_for_lot_selection();

DELETE FROM tender.region_recalculation_jobs
WHERE idempotency_key LIKE
        'migration-0162-selected-lot-region:%'
   OR idempotency_key LIKE
        'selected-lot-region-v2:%';

ALTER TABLE tender.region_recalculation_jobs
  ALTER COLUMN configuration_version_id SET NOT NULL,
  ALTER COLUMN region_profile_version_id SET NOT NULL;

DELETE FROM app.schema_migrations
WHERE version='0162-selected-lot-region-invariant';

COMMIT;
