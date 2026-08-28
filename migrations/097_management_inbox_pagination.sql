-- Management inbox 504 repair. Additive only; no recalculation or backfill is
-- performed by this migration.
SET lock_timeout='5s';
SET statement_timeout='10min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS service_relevance_current_filter_idx
 ON tender.service_relevance_evaluations(relevance_status,service_line,company_id,tender_id,lot_key,evaluation_version DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS management_inbox_active_page_idx
 ON tender.management_inbox(tenant_id,company_id,canonical_service,profile_id,region_profile_version_id,tender_id,service_line,created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS calculations_context_version_idx
 ON tender.calculations(tender_id,company_id,lot_key,version DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS approval_requests_context_latest_idx
 ON tender.approval_requests(tender_id,calculation_id,action_type,created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS autopilot_queue_context_latest_idx
 ON tender.autopilot_queue(tender_id,company_id,lot_key,created_at DESC);

ALTER TABLE tender.inbox_pipeline_runs DROP CONSTRAINT IF EXISTS inbox_pipeline_runs_run_kind_check;
ALTER TABLE tender.inbox_pipeline_runs ADD CONSTRAINT inbox_pipeline_runs_run_kind_check
 CHECK(run_kind IN('SCHEDULED','BACKFILL','MANUAL','TEST','REGION_CONFIGURATION'));

CREATE TABLE IF NOT EXISTS tender.region_recalculation_jobs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tender.configuration_tenants(id),
  company_id uuid NOT NULL REFERENCES tender.enterprise_company_links(company_id),
  canonical_service text NOT NULL CHECK(canonical_service IN('security','cleaning','facility_management','sicherheitstechnik','emergency_services')),
  profile_id uuid NOT NULL REFERENCES tender.company_profiles(id),
  configuration_version_id uuid NOT NULL REFERENCES tender.configuration_versions(id),
  region_profile_version_id uuid NOT NULL REFERENCES tender.region_profile_versions(id),
  status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','RUNNING','SUCCESS','FAILED')),
  total_count integer NOT NULL DEFAULT 0 CHECK(total_count>=0),
  processed_count integer NOT NULL DEFAULT 0 CHECK(processed_count>=0),
  lease_owner text,
  lease_until timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL UNIQUE,
  FOREIGN KEY(tenant_id,company_id,canonical_service,profile_id)
    REFERENCES tender.configuration_scopes(tenant_id,company_id,canonical_service,profile_id)
);
CREATE INDEX IF NOT EXISTS region_recalculation_jobs_claim_idx
 ON tender.region_recalculation_jobs(status,lease_until,created_at);
CREATE INDEX IF NOT EXISTS region_recalculation_jobs_scope_idx
 ON tender.region_recalculation_jobs(tenant_id,company_id,canonical_service,profile_id,region_profile_version_id,created_at DESC);

ALTER TABLE tender.region_recalculation_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS configuration_tenant_isolation ON tender.region_recalculation_jobs;
CREATE POLICY configuration_tenant_isolation ON tender.region_recalculation_jobs
 USING(tenant_id::text=current_setting('app.configuration_tenant_id',true))
 WITH CHECK(tenant_id::text=current_setting('app.configuration_tenant_id',true));
