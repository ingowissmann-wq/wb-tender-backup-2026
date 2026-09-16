BEGIN;

CREATE TABLE IF NOT EXISTS saas.trial_onboarding_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  customer_identity_hash text NOT NULL,
  verification_token_hash text,
  verification_expires_at timestamptz,
  email_verified_at timestamptz,
  tenant_id uuid,
  booking_id uuid NOT NULL DEFAULT gen_random_uuid(),
  checkout_provider text,
  checkout_ref text,
  payment_confirmed_at timestamptz,
  setup_token_hash text,
  setup_expires_at timestamptz,
  activated_at timestamptz,
  status text NOT NULL DEFAULT 'EMAIL_VERIFICATION_PENDING',
  request_ip_hash text,
  request_user_agent_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trial_onboarding_status_check CHECK (status IN (
    'EMAIL_VERIFICATION_PENDING',
    'EMAIL_VERIFIED',
    'CHECKOUT_CREATED',
    'ACCOUNT_SETUP_PENDING',
    'MFA_SETUP_PENDING',
    'ACTIVATED',
    'EXPIRED',
    'CANCELLED'
  )),
  CONSTRAINT trial_onboarding_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES saas.tenants(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS trial_onboarding_booking_uidx
  ON saas.trial_onboarding_intents(booking_id);

CREATE UNIQUE INDEX IF NOT EXISTS trial_onboarding_verification_uidx
  ON saas.trial_onboarding_intents(verification_token_hash)
  WHERE verification_token_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS trial_onboarding_checkout_uidx
  ON saas.trial_onboarding_intents(checkout_provider,checkout_ref)
  WHERE checkout_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS trial_onboarding_setup_token_uidx
  ON saas.trial_onboarding_intents(setup_token_hash)
  WHERE setup_token_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS trial_onboarding_active_identity_uidx
  ON saas.trial_onboarding_intents(customer_identity_hash)
  WHERE status IN (
    'EMAIL_VERIFICATION_PENDING','EMAIL_VERIFIED','CHECKOUT_CREATED',
    'ACCOUNT_SETUP_PENDING','MFA_SETUP_PENDING'
  );

CREATE INDEX IF NOT EXISTS trial_onboarding_tenant_idx
  ON saas.trial_onboarding_intents(tenant_id)
  WHERE tenant_id IS NOT NULL;

COMMENT ON TABLE saas.trial_onboarding_intents IS
  'Email-first paid-trial state. Fine-grained onboarding state is isolated here; pending_registrations keeps its production status contract.';

COMMIT;
