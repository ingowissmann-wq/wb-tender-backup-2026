BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:migration:158-owner-mfa-challenge-contract',0));

CREATE TABLE IF NOT EXISTS iam.login_challenges(
  challenge_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
  user_agent_hash text NOT NULL,
  network_hash text NOT NULL,
  mfa_setup_secret_encrypted text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='iam.login_challenges'::regclass
      AND conname='login_challenges_attempts_check'
  ) THEN
    ALTER TABLE iam.login_challenges
      ADD CONSTRAINT login_challenges_attempts_check
      CHECK(attempts BETWEEN 0 AND 8) NOT VALID;
  END IF;
END $$;

ALTER TABLE iam.login_challenges
  VALIDATE CONSTRAINT login_challenges_attempts_check;

CREATE INDEX IF NOT EXISTS login_challenges_user_active_idx
  ON iam.login_challenges(user_id,expires_at)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS login_challenges_expiry_idx
  ON iam.login_challenges(expires_at);

INSERT INTO tender.audit_events(action,metadata)
SELECT
  'OWNER_MFA_CHALLENGE_CONTRACT_INSTALLED',
  jsonb_build_object(
    'release','20260829-owner-mfa-challenge-contract-158.1',
    'challengeSchemaInstalled',true,
    'existingUsersChanged',false,
    'existingPasswordsChanged',false,
    'existingMfaSecretsChanged',false,
    'existingSessionsChanged',false,
    'externalWrite',false,
    'externalSubmission',false,
    'transmitted',false
  )
WHERE NOT EXISTS (
  SELECT 1 FROM app.schema_migrations
  WHERE version='0158-owner-mfa-challenge-contract'
);

INSERT INTO app.schema_migrations(version,description)
VALUES(
  '0158-owner-mfa-challenge-contract',
  'Add the bounded owner MFA login-challenge table required for QR-based first enrollment without changing existing users, passwords, MFA secrets or sessions'
)
ON CONFLICT(version) DO NOTHING;

COMMIT;
