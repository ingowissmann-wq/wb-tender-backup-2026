BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:migration:159-owner-auth-runtime-privileges-down',0));

INSERT INTO tender.audit_events(action,metadata)
VALUES(
  'OWNER_AUTH_RUNTIME_PRIVILEGES_ROLLBACK_RECORDED',
  jsonb_build_object(
    'release','20260830-owner-auth-runtime-privileges-159.1',
    'runtimePrivilegesRetained',true,
    'identityRowsChanged',false,
    'credentialRowsChanged',false,
    'sessionRowsChanged',false,
    'externalWrite',false,
    'externalSubmission',false,
    'transmitted',false
  )
);

COMMIT;
