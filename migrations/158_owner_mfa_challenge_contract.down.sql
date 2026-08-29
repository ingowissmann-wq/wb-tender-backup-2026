BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:migration:158-owner-mfa-challenge-contract-down',0));

INSERT INTO tender.audit_events(action,metadata)
SELECT
  'OWNER_MFA_CHALLENGE_CONTRACT_APPLICATION_ROLLED_BACK',
  jsonb_build_object(
    'release','20260829-owner-mfa-challenge-contract-158.1',
    'challengeTableRetained',true,
    'challengeRowsDeleted',false,
    'usersChanged',false,
    'passwordsChanged',false,
    'mfaSecretsChanged',false,
    'sessionsChanged',false,
    'externalSubmission',false
  )
WHERE EXISTS (
  SELECT 1 FROM app.schema_migrations
  WHERE version='0158-owner-mfa-challenge-contract'
);

-- Application-first rollback retains the additive challenge table, indexes,
-- constraints and any forensic challenge rows. Older code does not use the
-- table, so rollback requires no identity, credential or session mutation.
DELETE FROM app.schema_migrations
WHERE version='0158-owner-mfa-challenge-contract';

COMMIT;
