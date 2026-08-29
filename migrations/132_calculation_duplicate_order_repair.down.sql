BEGIN;

-- Preserve calculation records, corrected ordering, exact bindings and their
-- immutable audit trail. Reintroducing a falsely current duplicate is unsafe.
DELETE FROM app.schema_migrations
WHERE version='0132-calculation-duplicate-order-repair';

COMMIT;
