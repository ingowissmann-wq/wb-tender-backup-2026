BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:migration:155-c23-canonical-calculation-contract-down',0));

DELETE FROM iam.role_permissions binding
USING iam.roles role_row,iam.permissions permission_row
WHERE binding.role_id=role_row.id
  AND binding.permission_id=permission_row.id
  AND role_row.code IN('administrator','calculation')
  AND permission_row.code='tender.calculation.sandbox';

DELETE FROM iam.permissions permission_row
WHERE permission_row.code='tender.calculation.sandbox'
  AND NOT EXISTS(
    SELECT 1
    FROM iam.role_permissions binding
    WHERE binding.permission_id=permission_row.id
  );

INSERT INTO tender.audit_events(action,metadata)
VALUES(
  'C23_CANONICAL_CALCULATION_CONTRACT_ROLLED_BACK',
  jsonb_build_object(
    'release','20260829-c23-canonical-calculation-contract-155.1',
    'businessRowsDeleted',false,
    'configurationRowsDeleted',false,
    'calculationRowsDeleted',false,
    'externalSubmission',false
  )
);

INSERT INTO app.schema_migrations(version,description)
VALUES(
  '0155-c23-canonical-calculation-contract-down',
  'Remove only the calculation sandbox role bindings introduced by migration 155 while preserving all business and configuration data'
)
ON CONFLICT(version) DO NOTHING;

COMMIT;
