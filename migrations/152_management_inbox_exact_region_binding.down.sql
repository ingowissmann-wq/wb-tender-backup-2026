SET lock_timeout='5s';
SET statement_timeout='10min';

DROP INDEX CONCURRENTLY IF EXISTS tender.region_evaluations_management_inbox_exact_idx;
