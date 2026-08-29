BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:migration:156-c11-hourly-material-contract',0));

INSERT INTO tender.audit_events(action,metadata)
SELECT
  'C11_HOURLY_MATERIAL_CONTRACT_INSTALLED',
  jsonb_build_object(
    'release','20260829-c11-hourly-material-contract-156.1',
    'parameterKey','C11',
    'allowedUnit','EUR_PER_HOUR',
    'quantitySource','productiveHours',
    'defaultValueCreated',false,
    'existingConfigurationChanged',false,
    'existingCalculationsChanged',false,
    'externalWrite',false,
    'externalSubmission',false,
    'transmitted',false
  )
WHERE NOT EXISTS (
  SELECT 1
  FROM app.schema_migrations
  WHERE version='0156-c11-hourly-material-contract'
);

INSERT INTO app.schema_migrations(version,description)
VALUES(
  '0156-c11-hourly-material-contract',
  'Register EUR_PER_HOUR as an allowed C11 material-cost contract without creating defaults or changing business configuration'
)
ON CONFLICT(version) DO NOTHING;

COMMIT;
