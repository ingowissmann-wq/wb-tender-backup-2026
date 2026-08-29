BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:migration:155-c23-canonical-calculation-contract',0));

DO $$
DECLARE
  missing_roles text[];
BEGIN
  SELECT array_agg(required.code ORDER BY required.code)
  INTO missing_roles
  FROM (VALUES ('administrator'),('calculation')) AS required(code)
  WHERE NOT EXISTS (
    SELECT 1 FROM iam.roles role_row WHERE role_row.code=required.code
  );

  IF coalesce(cardinality(missing_roles),0)>0 THEN
    RAISE EXCEPTION USING
      ERRCODE='23514',
      MESSAGE='c23_sandbox_required_roles_missing',
      DETAIL=array_to_string(missing_roles,',');
  END IF;
END $$;

INSERT INTO iam.permissions(code)
VALUES('tender.calculation.sandbox')
ON CONFLICT(code) DO NOTHING;

INSERT INTO iam.role_permissions(role_id,permission_id)
SELECT role_row.id,permission_row.id
FROM iam.roles role_row
CROSS JOIN iam.permissions permission_row
WHERE role_row.code IN('administrator','calculation')
  AND permission_row.code='tender.calculation.sandbox'
ON CONFLICT(role_id,permission_id) DO NOTHING;

INSERT INTO tender.audit_events(action,metadata)
VALUES(
  'C23_CANONICAL_CALCULATION_CONTRACT_INSTALLED',
  jsonb_build_object(
    'release','20260829-c23-canonical-calculation-contract-155.1',
    'calculationSchemaVersion',5,
    'parameterKey','C23',
    'unit','HOURS_PER_YEAR',
    'defaultValueCreated',false,
    'existingConfigurationChanged',false,
    'existingCalculationsChanged',false,
    'sandboxPermission','tender.calculation.sandbox',
    'sandboxRoles',jsonb_build_array('administrator','calculation'),
    'sandboxPersisted',false,
    'externalWrite',false,
    'externalSubmission',false,
    'transmitted',false
  )
);

INSERT INTO app.schema_migrations(version,description)
VALUES(
  '0155-c23-canonical-calculation-contract',
  'Register the isolated calculation sandbox permission for the canonical C23 annual-hours contract without creating defaults or changing business data'
)
ON CONFLICT(version) DO NOTHING;

COMMIT;
