BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';

CREATE TABLE IF NOT EXISTS tender.inbox_pipeline_runs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_run_id uuid REFERENCES tender.scheduler_runs(id),
  run_kind text NOT NULL CHECK(run_kind IN('SCHEDULED','BACKFILL','MANUAL','TEST')),
  status text NOT NULL CHECK(status IN('RUNNING','SUCCESS','FAILED')),
  cutoff_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  checked_count integer NOT NULL DEFAULT 0,
  matched_count integer NOT NULL DEFAULT 0,
  inbox_created_count integer NOT NULL DEFAULT 0,
  region_created_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  error_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS tender.inbox_pipeline_items(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES tender.inbox_pipeline_runs(id),
  tender_id uuid NOT NULL REFERENCES tender.tenders(id),
  company_id uuid NOT NULL REFERENCES tender.enterprise_company_links(company_id),
  lot_key text NOT NULL DEFAULT '',
  classification_status text NOT NULL,
  region_status text NOT NULL,
  document_status text NOT NULL,
  matching_status text NOT NULL,
  inbox_status text NOT NULL,
  exclusion_reason text,
  pipeline_fingerprint char(64) NOT NULL,
  location_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,tender_id,company_id,lot_key)
);

CREATE INDEX IF NOT EXISTS inbox_pipeline_runs_latest_idx ON tender.inbox_pipeline_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS inbox_pipeline_items_tender_idx ON tender.inbox_pipeline_items(tender_id,company_id,created_at DESC);
CREATE INDEX IF NOT EXISTS inbox_pipeline_items_failure_idx ON tender.inbox_pipeline_items(region_status,matching_status,inbox_status) WHERE inbox_status<>'CREATED';

COMMIT;
