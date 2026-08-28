BEGIN;

ALTER TABLE tender.portal_registry
  ADD COLUMN IF NOT EXISTS registration_entry_url text,
  ADD COLUMN IF NOT EXISTS entry_links_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS entry_links_verified_by uuid REFERENCES iam.users(id);

COMMENT ON COLUMN tender.portal_registry.registration_entry_url IS
  'Administratively verified official registration entry. Never inferred from a portal name.';
COMMENT ON COLUMN tender.portal_registry.entry_links_verified_at IS
  'Timestamp of the explicit administrative verification of login and registration entries.';

ALTER TABLE tender.portal_registry
  DROP CONSTRAINT IF EXISTS portal_registry_registration_entry_https,
  ADD CONSTRAINT portal_registry_registration_entry_https
    CHECK(registration_entry_url IS NULL OR registration_entry_url ~ '^https://[^/?#]+/');

ALTER TABLE tender.portal_credential_secrets
  ADD COLUMN IF NOT EXISTS registration_status text NOT NULL DEFAULT 'MANUELLE_PRUEFUNG',
  ADD COLUMN IF NOT EXISTS login_status text NOT NULL DEFAULT 'LOGIN_UNGEPRUEFT',
  ADD COLUMN IF NOT EXISTS mfa_required_state boolean,
  ADD COLUMN IF NOT EXISTS last_manual_check_at timestamptz;

ALTER TABLE tender.portal_credential_secrets
  DROP CONSTRAINT IF EXISTS portal_credential_registration_status_chk,
  ADD CONSTRAINT portal_credential_registration_status_chk CHECK(registration_status IN('NICHT_REGISTRIERT','REGISTRIERUNG_OFFEN','REGISTRIERT','MANUELLE_PRUEFUNG')),
  DROP CONSTRAINT IF EXISTS portal_credential_login_status_chk,
  ADD CONSTRAINT portal_credential_login_status_chk CHECK(login_status IN('LOGIN_UNGEPRUEFT','LOGIN_BESTAETIGT','MFA_ERFORDERLICH','ZUGANG_GESPERRT','ZUGANG_ABGELAUFEN','MANUELLE_PRUEFUNG'));

COMMIT;
