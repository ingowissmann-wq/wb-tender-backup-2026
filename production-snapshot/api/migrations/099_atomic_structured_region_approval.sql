BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';

DO $guard$
BEGIN
  IF EXISTS(
    SELECT 1
    FROM tender.region_profile_versions
    WHERE status='ACTIVE'
    GROUP BY tenant_id,company_id,canonical_service,profile_id
    HAVING count(*)>1
  ) THEN
    RAISE EXCEPTION 'multiple_active_region_profile_versions';
  END IF;
END
$guard$;

CREATE UNIQUE INDEX IF NOT EXISTS region_profile_versions_one_active_scope_idx
  ON tender.region_profile_versions(tenant_id,company_id,canonical_service,profile_id)
  WHERE status='ACTIVE';

COMMIT;
