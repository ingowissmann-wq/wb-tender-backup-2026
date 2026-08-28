BEGIN;

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';

-- Expand-only rollback: exact immutable bindings and repaired derived context
-- identities remain available to the prior application. No business row is removed.
DELETE FROM app.schema_migrations WHERE version='0127-authoritative-pipeline-enrichment-binding';

COMMIT;
