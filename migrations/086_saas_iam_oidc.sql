BEGIN;

CREATE TABLE IF NOT EXISTS saas.iam_subject_bindings(
  issuer text NOT NULL,
  subject text NOT NULL,
  user_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  email text NOT NULL,
  email_verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY(issuer,subject),
  UNIQUE(user_id),
  UNIQUE(tenant_id,user_id)
);

CREATE TABLE IF NOT EXISTS saas.iam_login_states(
  state_hash char(64) PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saas.iam_sessions(
  token_hash char(64) PRIMARY KEY,
  csrf_hash char(64) NOT NULL,
  user_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject text NOT NULL,
  email text NOT NULL,
  user_agent_hash char(64) NOT NULL,
  mfa_verified_at timestamptz NOT NULL,
  email_verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY(issuer,subject) REFERENCES saas.iam_subject_bindings(issuer,subject)
);

CREATE INDEX IF NOT EXISTS saas_iam_sessions_expiry ON saas.iam_sessions(expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS saas_iam_login_states_expiry ON saas.iam_login_states(expires_at);

REVOKE ALL ON saas.iam_subject_bindings,saas.iam_login_states,saas.iam_sessions FROM PUBLIC;

COMMIT;

