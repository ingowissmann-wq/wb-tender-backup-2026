BEGIN;
DROP TRIGGER IF EXISTS configuration_scope_region_recalculation ON tender.configuration_scopes;
DROP FUNCTION IF EXISTS tender.enqueue_region_recalculation_for_scope();
DELETE FROM tender.region_recalculation_jobs
WHERE idempotency_key LIKE 'migration-0161-durable-exact-lot-region:%'
   OR idempotency_key LIKE 'scope-region-v2:%';
DELETE FROM app.schema_migrations
WHERE version='0161-durable-exact-lot-region-invariant';
COMMIT;
