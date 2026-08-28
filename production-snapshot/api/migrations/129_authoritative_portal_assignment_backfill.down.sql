BEGIN;

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';

-- Expand-only rollback: authoritative assignments and role-aware resolution
-- uniqueness are business evidence and remain compatible with the previous
-- application. Never delete them or collapse distinct portal roles.
DELETE FROM app.schema_migrations
WHERE version='0129-authoritative-portal-assignment-backfill';

COMMIT;
