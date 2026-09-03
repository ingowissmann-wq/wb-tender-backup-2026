-- Additive, online lookup indexes for the Autopilot overview.  No business
-- data is changed.  Run without a surrounding transaction because PostgreSQL
-- requires that for CONCURRENTLY.
CREATE INDEX CONCURRENTLY IF NOT EXISTS autopilot_results_overview_latest_idx
  ON tender.autopilot_results(tender_id,company_id,lot_key,result_version DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS autopilot_queue_full_pipeline_latest_idx
  ON tender.autopilot_queue(tender_id,company_id,lot_key,created_at DESC)
  WHERE action_type='RUN_FULL_PIPELINE';

CREATE INDEX CONCURRENTLY IF NOT EXISTS enrichment_versions_overview_latest_idx
  ON tender.enrichment_versions(tender_id,version DESC)
  WHERE historical=false;
