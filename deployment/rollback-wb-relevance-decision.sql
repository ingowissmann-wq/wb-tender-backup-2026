BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='10min';

-- Application rollback is intentionally data preserving. The prior release
-- ignores these additive fields; the preclassification dump is the audited
-- path for an exact data rollback.
DROP INDEX IF EXISTS tender.tenders_wb_customer_overview_idx;

COMMIT;
