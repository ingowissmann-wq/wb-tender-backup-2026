BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';

-- Business rows and the immutable repair audit are deliberately retained.
-- Recreating ambiguous duplicate version numbers would corrupt references.
DROP INDEX IF EXISTS tender.calculations_context_version_uq;

DELETE FROM app.schema_migrations
WHERE version='0131-calculation-version-concurrency';

COMMIT;
