BEGIN;
SET LOCAL lock_timeout='5s';
DROP INDEX IF EXISTS tender.region_profile_versions_one_active_scope_idx;
COMMIT;
