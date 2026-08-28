BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DROP TRIGGER IF EXISTS canonical_lot_context_continuity ON tender.tender_lot_lifecycles;
DROP FUNCTION IF EXISTS tender.materialize_canonical_lot_from_lifecycle();
DELETE FROM app.schema_migrations WHERE version='0123-canonical-lot-context-continuity';

-- Intentionally preserve every canonical lot and audit row produced by the
-- forward migration. Application rollback must retain all productive data.

COMMIT;
