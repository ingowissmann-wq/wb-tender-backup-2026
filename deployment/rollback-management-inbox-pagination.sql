-- Application/image rollback must happen first. This removes only the additive
-- worker queue and indexes; it does not change inbox rows, user decisions,
-- region values, configuration versions, or relevance classifications.
SET lock_timeout='5s';
SET statement_timeout='10min';

DROP TABLE IF EXISTS tender.region_recalculation_jobs;
ALTER TABLE tender.inbox_pipeline_runs DROP CONSTRAINT IF EXISTS inbox_pipeline_runs_run_kind_check;
ALTER TABLE tender.inbox_pipeline_runs ADD CONSTRAINT inbox_pipeline_runs_run_kind_check
 CHECK(run_kind IN('SCHEDULED','BACKFILL','MANUAL','TEST'));
DROP INDEX CONCURRENTLY IF EXISTS tender.autopilot_queue_context_latest_idx;
DROP INDEX CONCURRENTLY IF EXISTS tender.approval_requests_context_latest_idx;
DROP INDEX CONCURRENTLY IF EXISTS tender.calculations_context_version_idx;
DROP INDEX CONCURRENTLY IF EXISTS tender.management_inbox_active_page_idx;
DROP INDEX CONCURRENTLY IF EXISTS tender.service_relevance_current_filter_idx;
