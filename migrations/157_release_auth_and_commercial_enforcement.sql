CREATE TABLE IF NOT EXISTS iam.tender_login_challenges(
  challenge_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
  user_agent_hash text NOT NULL,
  network_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tender_login_challenges_expiry_idx ON iam.tender_login_challenges(expires_at);
REVOKE ALL ON iam.tender_login_challenges FROM PUBLIC;

ALTER TABLE saas.plans DROP CONSTRAINT IF EXISTS saas_approved_tender_price_boundary_chk;
ALTER TABLE saas.plans ADD CONSTRAINT saas_approved_tender_price_boundary_chk CHECK (
  price_status <> 'APPROVED' OR CASE code
    WHEN 'NORMAL' THEN recommended_monthly_price_minor = 99000
    WHEN 'PROFESSIONAL' THEN recommended_monthly_price_minor = 149000
    WHEN 'ENTERPRISE' THEN recommended_monthly_price_minor = 249000
    ELSE false
  END
);
