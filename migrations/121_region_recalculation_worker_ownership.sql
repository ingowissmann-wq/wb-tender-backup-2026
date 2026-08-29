BEGIN;

-- Region recalculation is a background-worker responsibility.  Older API
-- releases used to start the same consumer and can remain online as rollback
-- candidates.  Fail closed if such an API process attempts to claim a new job.
UPDATE tender.region_recalculation_jobs
SET status='QUEUED',
    lease_owner=NULL,
    lease_until=NULL,
    started_at=NULL,
    updated_at=now(),
    error_code='LEGACY_API_LEASE_RELEASED'
WHERE status='RUNNING'
  AND lease_owner IS NOT NULL
  AND lease_owner NOT LIKE 'region-worker:%';

ALTER TABLE tender.region_recalculation_jobs
  DROP CONSTRAINT IF EXISTS region_recalculation_jobs_worker_owner_check;
ALTER TABLE tender.region_recalculation_jobs
  ADD CONSTRAINT region_recalculation_jobs_worker_owner_check
  CHECK (
    status <> 'RUNNING'
    OR lease_owner LIKE 'region-worker:%'
  );

COMMIT;
