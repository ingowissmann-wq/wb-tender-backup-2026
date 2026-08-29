BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:migration:157-versioned-calculation-input-snapshot-down',0));

INSERT INTO tender.audit_events(action,metadata)
SELECT
  'VERSIONED_CALCULATION_INPUT_SNAPSHOT_APPLICATION_ROLLED_BACK',
  jsonb_build_object(
    'release','20260829-versioned-calculation-input-snapshot-157.1',
    'additiveColumnsRetained',true,
    'snapshotRowsDeleted',false,
    'calculationRowsDeleted',false,
    'managementOutputRowsDeleted',false,
    'externalSubmission',false
  )
WHERE EXISTS (
  SELECT 1 FROM app.schema_migrations
  WHERE version='0157-versioned-calculation-input-snapshot'
);

-- Application-first rollback deliberately retains the additive columns,
-- constraints, triggers and any immutable version-4 evidence. Older code does
-- not address these nullable fields, so no business or forensic data is lost.
DELETE FROM app.schema_migrations
WHERE version='0157-versioned-calculation-input-snapshot';

COMMIT;
