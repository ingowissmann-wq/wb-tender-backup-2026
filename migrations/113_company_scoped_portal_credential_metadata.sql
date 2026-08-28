BEGIN;
SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='30s';

ALTER TABLE tender.portal_credential_companies
  ADD COLUMN IF NOT EXISTS metadata_configured boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS internal_label text,
  ADD COLUMN IF NOT EXISTS contact_person text,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS registration_status text,
  ADD COLUMN IF NOT EXISTS login_status text,
  ADD COLUMN IF NOT EXISTS mfa_required_state boolean,
  ADD COLUMN IF NOT EXISTS last_manual_check_at timestamptz;

ALTER TABLE tender.portal_credential_companies
  DROP CONSTRAINT IF EXISTS portal_credential_company_registration_status_chk,
  ADD CONSTRAINT portal_credential_company_registration_status_chk CHECK (
    registration_status IS NULL OR registration_status IN ('NICHT_REGISTRIERT','REGISTRIERUNG_OFFEN','REGISTRIERT','MANUELLE_PRUEFUNG')
  ) NOT VALID,
  DROP CONSTRAINT IF EXISTS portal_credential_company_login_status_chk,
  ADD CONSTRAINT portal_credential_company_login_status_chk CHECK (
    login_status IS NULL OR login_status IN ('LOGIN_UNGEPRUEFT','LOGIN_BESTAETIGT','MFA_ERFORDERLICH','ZUGANG_GESPERRT','ZUGANG_ABGELAUFEN','MANUELLE_PRUEFUNG')
  ) NOT VALID,
  DROP CONSTRAINT IF EXISTS portal_credential_company_internal_label_length_chk,
  ADD CONSTRAINT portal_credential_company_internal_label_length_chk CHECK (internal_label IS NULL OR char_length(internal_label)<=120) NOT VALID,
  DROP CONSTRAINT IF EXISTS portal_credential_company_contact_person_length_chk,
  ADD CONSTRAINT portal_credential_company_contact_person_length_chk CHECK (contact_person IS NULL OR char_length(contact_person)<=160) NOT VALID,
  DROP CONSTRAINT IF EXISTS portal_credential_company_notes_length_chk,
  ADD CONSTRAINT portal_credential_company_notes_length_chk CHECK (notes IS NULL OR char_length(notes)<=1000) NOT VALID;

ALTER TABLE tender.portal_credential_companies VALIDATE CONSTRAINT portal_credential_company_registration_status_chk;
ALTER TABLE tender.portal_credential_companies VALIDATE CONSTRAINT portal_credential_company_login_status_chk;
ALTER TABLE tender.portal_credential_companies VALIDATE CONSTRAINT portal_credential_company_internal_label_length_chk;
ALTER TABLE tender.portal_credential_companies VALIDATE CONSTRAINT portal_credential_company_contact_person_length_chk;
ALTER TABLE tender.portal_credential_companies VALIDATE CONSTRAINT portal_credential_company_notes_length_chk;

COMMENT ON COLUMN tender.portal_credential_companies.metadata_configured IS 'True only when non-secret access metadata was explicitly saved for this credential/company binding.';
COMMENT ON COLUMN tender.portal_credential_companies.internal_label IS 'Company-scoped non-secret label; encrypted credential material remains unchanged.';

COMMIT;
