BEGIN;

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';

-- Expand-only rollback: the per-host uniqueness is compatible with the old
-- application and prevents loss of newly classified host profiles.
DELETE FROM app.schema_migrations WHERE version='0128-portal-family-host-profiles';

COMMIT;
