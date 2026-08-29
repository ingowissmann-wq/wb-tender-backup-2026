BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:migration:156-c11-hourly-material-contract-down',0));

INSERT INTO tender.audit_events(action,metadata)
SELECT
  'C11_HOURLY_MATERIAL_CONTRACT_ROLLED_BACK',
  jsonb_build_object(
    'release','20260829-c11-hourly-material-contract-156.1',
    'businessRowsDeleted',false,
    'configurationRowsDeleted',false,
    'calculationRowsDeleted',false,
    'externalSubmission',false
  )
WHERE EXISTS (
  SELECT 1
  FROM app.schema_migrations
  WHERE version='0156-c11-hourly-material-contract'
);

DELETE FROM app.schema_migrations
WHERE version='0156-c11-hourly-material-contract';

COMMIT;
