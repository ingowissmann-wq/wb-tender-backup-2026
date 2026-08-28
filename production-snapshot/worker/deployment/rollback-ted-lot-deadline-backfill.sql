BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30min';
DROP INDEX IF EXISTS tender.tenders_wb_active_deadline_idx;
-- Row values are restored from the exact binary backup created immediately
-- before migration 094; this file intentionally performs no lossy inference.
COMMIT;
