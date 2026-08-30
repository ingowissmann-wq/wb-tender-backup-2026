BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:migration:159-owner-auth-runtime-privileges',0));

DO $$
BEGIN
  IF NOT EXISTS(
    SELECT 1
    FROM pg_roles
    WHERE rolname='tender_api_runtime'
  ) THEN
    RAISE EXCEPTION 'required role tender_api_runtime is missing';
  END IF;

  IF EXISTS(
    SELECT 1
    FROM pg_roles
    WHERE rolname='tender_api_runtime'
      AND (
        rolcanlogin OR rolsuper OR rolbypassrls OR
        rolcreatedb OR rolcreaterole OR rolreplication
      )
  ) THEN
    RAISE EXCEPTION 'unsafe tender_api_runtime role';
  END IF;
END $$;

GRANT USAGE ON SCHEMA iam TO tender_api_runtime;

GRANT SELECT ON
  iam.users,
  iam.password_reset_tokens,
  iam.login_attempts,
  iam.login_challenges,
  iam.recovery_codes,
  iam.sessions
TO tender_api_runtime;

GRANT INSERT ON
  iam.password_reset_events,
  iam.login_attempts,
  iam.login_challenges,
  iam.recovery_codes,
  iam.sessions
TO tender_api_runtime;

GRANT DELETE ON
  iam.login_challenges,
  iam.recovery_codes
TO tender_api_runtime;

GRANT UPDATE(password_hash,mfa_required,mfa_secret_encrypted,mfa_last_counter,failed_attempts,locked_until,updated_at)
  ON iam.users TO tender_api_runtime;
GRANT UPDATE(used_at)
  ON iam.password_reset_tokens TO tender_api_runtime;
GRANT UPDATE(attempts,used_at)
  ON iam.login_challenges TO tender_api_runtime;
GRANT UPDATE(used_at)
  ON iam.recovery_codes TO tender_api_runtime;
GRANT UPDATE(revoked_at)
  ON iam.sessions TO tender_api_runtime;

SELECT format(
  'GRANT USAGE, SELECT ON SEQUENCE %I.%I TO tender_api_runtime',
  sequence_namespace.nspname,
  sequence_row.relname
)
FROM pg_class sequence_row
JOIN pg_namespace sequence_namespace
  ON sequence_namespace.oid=sequence_row.relnamespace
JOIN pg_depend dependency
  ON dependency.objid=sequence_row.oid
JOIN pg_class table_row
  ON table_row.oid=dependency.refobjid
JOIN pg_namespace table_namespace
  ON table_namespace.oid=table_row.relnamespace
WHERE sequence_row.relkind='S'
  AND table_namespace.nspname='iam'
  AND table_row.relname IN(
    'users',
    'password_reset_tokens',
    'password_reset_events',
    'login_attempts',
    'login_challenges',
    'recovery_codes',
    'sessions'
  )
\gexec

INSERT INTO tender.audit_events(action,metadata)
SELECT
  'OWNER_AUTH_RUNTIME_PRIVILEGES_INSTALLED',
  jsonb_build_object(
    'release','20260830-owner-auth-runtime-privileges-159.1',
    'runtimeRole','tender_api_runtime',
    'loginRoleChanged',false,
    'administrativeAttributesGranted',false,
    'identityRowsChanged',false,
    'credentialRowsChanged',false,
    'sessionRowsChanged',false,
    'externalWrite',false,
    'externalSubmission',false,
    'transmitted',false
  )
WHERE NOT EXISTS(
  SELECT 1 FROM app.schema_migrations
  WHERE version='0159-owner-auth-runtime-privileges'
);

INSERT INTO app.schema_migrations(version,description)
VALUES(
  '0159-owner-auth-runtime-privileges',
  'Grant the non-login API runtime role the least privileges required for owner password, MFA challenge, recovery-code and session lifecycle'
)
ON CONFLICT(version) DO NOTHING;

COMMIT;
