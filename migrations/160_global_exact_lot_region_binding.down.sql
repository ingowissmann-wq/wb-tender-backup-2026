BEGIN;
SET LOCAL lock_timeout='10s';
DELETE FROM tender.region_recalculation_jobs WHERE status='QUEUED'
 AND idempotency_key LIKE 'migration-0160-global-exact-lot-region:%';
COMMIT;
