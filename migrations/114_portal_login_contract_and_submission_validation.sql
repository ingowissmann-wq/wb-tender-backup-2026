BEGIN;

-- Every target below was discovered from the portal's own productive page or
-- redirect chain on 2026-08-21.  No credential or company binding is changed.
UPDATE tender.portal_registry SET
  display_name='Deutsche eVergabe – Bieterzugang', adapter_id='deutsche-evergabe',
  adapter_version='1.1.0-bieterzugang', adapter_enabled=true,
  adapter_validation_status='LOGIN_REQUIRED', login_strategy='BROWSER',
  authentication_entry_url='https://bieterzugang.deutsche-evergabe.de/evergabe.bieter/login.aspx',
  bidder_area_url='https://bieterzugang.deutsche-evergabe.de/evergabe.bieter/login.aspx',
  authentication_domains=ARRAY['bieterzugang.deutsche-evergabe.de'],
  allowed_subdomains=ARRAY['bieterzugang.deutsche-evergabe.de'],
  allowed_return_paths=ARRAY['/evergabe.bieter/'],
  capabilities=ARRAY['LOGIN_HTTP_FORM','CSRF_REQUIRED','BIDDER_LOGIN','AUTHENTICATED_DOCUMENTS_REQUIRED'],
  last_error_code=NULL, entry_links_verified_at=now(), last_verified_at=now(), updated_at=now()
WHERE canonical_domain='bieterzugang.deutsche-evergabe.de';

INSERT INTO tender.portal_connector_adapters(adapter_id,adapter_version,contract_version,canonical_domain,authentication_domains,download_domains,capabilities,login_strategy,document_strategy,allowed_return_paths,enabled,validation_status,last_verified_at)
VALUES('deutsche-evergabe','1.1.0-bieterzugang','2.0.0','bieterzugang.deutsche-evergabe.de',ARRAY['bieterzugang.deutsche-evergabe.de'],ARRAY[]::text[],ARRAY['LOGIN_HTTP_FORM','CSRF_REQUIRED','BIDDER_LOGIN','AUTHENTICATED_DOCUMENTS_REQUIRED'],'BROWSER','PORTAL_BOUND_DOCUMENT_AREA',ARRAY['/evergabe.bieter/'],true,'CREDENTIAL_REQUIRED',now())
ON CONFLICT(canonical_domain,adapter_version) DO UPDATE SET adapter_id=excluded.adapter_id,contract_version=excluded.contract_version,authentication_domains=excluded.authentication_domains,capabilities=excluded.capabilities,login_strategy=excluded.login_strategy,document_strategy=excluded.document_strategy,allowed_return_paths=excluded.allowed_return_paths,enabled=true,validation_status='CREDENTIAL_REQUIRED',last_verified_at=now(),updated_at=now();

UPDATE tender.portal_registry SET
  authentication_entry_url='https://www.meinauftrag.rib.de/dashboard/index',
  bidder_area_url='https://www.meinauftrag.rib.de/dashboard/index',
  registration_entry_url='https://www.meinauftrag.rib.de/public/registerCompany',
  entry_links_verified_at=now(), updated_at=now()
WHERE canonical_domain='www.meinauftrag.rib.de';

UPDATE tender.portal_registry SET
  authentication_entry_url='https://login.vergabe24.de/Account/Login',
  bidder_area_url='https://login.vergabe24.de/Account/Login',
  entry_links_verified_at=now(), updated_at=now()
WHERE canonical_domain='www.vergabe24.de';

UPDATE tender.portal_registry SET
  authentication_entry_url='https://www.evergabe.de/anmelden',
  bidder_area_url='https://www.evergabe.de/anmelden',
  registration_entry_url='https://www.evergabe.de/konto-erstellen',
  entry_links_verified_at=now(), updated_at=now()
WHERE canonical_domain='www.evergabe.de';

UPDATE tender.portal_registry SET
  authentication_entry_url='https://my.vergabe.bayern.de/',
  bidder_area_url='https://my.vergabe.bayern.de/',
  authentication_domains=(SELECT ARRAY(SELECT DISTINCT x FROM unnest(coalesce(authentication_domains,'{}'::text[])||ARRAY['my.vergabe.bayern.de']) x ORDER BY x)),
  entry_links_verified_at=now(), updated_at=now()
WHERE canonical_domain='www.evergabe.bayern.de';

UPDATE tender.portal_registry SET
  bidder_area_url=authentication_entry_url,
  entry_links_verified_at=coalesce(entry_links_verified_at,now()), updated_at=now()
WHERE canonical_domain='www.dtvp.de' AND authentication_entry_url IS NOT NULL AND bidder_area_url IS NULL;

UPDATE tender.portal_connector_adapters SET last_verified_at=now(),updated_at=now()
WHERE canonical_domain IN('www.meinauftrag.rib.de','www.vergabe24.de','www.evergabe.de');
UPDATE tender.portal_connector_adapters SET authentication_domains=(SELECT ARRAY(SELECT DISTINCT value FROM unnest(authentication_domains||ARRAY['my.vergabe.bayern.de']) value ORDER BY value)),last_verified_at=now(),updated_at=now()
WHERE canonical_domain='www.evergabe.bayern.de';
UPDATE tender.portal_connector_adapters SET authentication_domains=(SELECT ARRAY(SELECT DISTINCT value FROM unnest(authentication_domains||ARRAY['id.dtvp.de']) value ORDER BY value)),last_verified_at=now(),updated_at=now()
WHERE canonical_domain='www.dtvp.de';

UPDATE tender.portal_capability_features feature SET
  portal_support='SUPPORTED', autopilot_supported=true, actively_configured=true,
  production_tested=false, browser_acceptance_passed=false,
  evidence_url='https://bieterzugang.deutsche-evergabe.de/evergabe.bieter/login.aspx',
  evidence_note='Produktives Bieter-Loginformular mit Benutzername, Passwort und serverseitigem Submit am 2026-08-21 nachgewiesen; authentifizierter Login steht noch aus.',
  verified_at=now()
FROM tender.portal_capability_profiles profile JOIN tender.portal_registry portal ON portal.id=profile.portal_id
WHERE feature.profile_id=profile.id AND portal.canonical_domain='bieterzugang.deutsche-evergabe.de' AND feature.feature_key='LOGIN';

CREATE TABLE IF NOT EXISTS tender.portal_submission_adapter_validations(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_id uuid NOT NULL REFERENCES tender.portal_registry(id),
  company_id uuid NOT NULL REFERENCES tender.enterprise_company_links(company_id),
  credential_id uuid REFERENCES tender.portal_credential_secrets(id),
  adapter_id text,
  adapter_version text,
  validation_status text NOT NULL CHECK(validation_status IN('NON_BINDING_PREFLIGHT_VALIDATED','BLOCKED_CONFIGURATION_INCOMPLETE')),
  checks jsonb NOT NULL,
  blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
  external_write boolean NOT NULL DEFAULT false CHECK(external_write=false),
  transmitted boolean NOT NULL DEFAULT false CHECK(transmitted=false),
  request_id text,
  validated_by uuid REFERENCES iam.users(id),
  validated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS portal_submission_adapter_validations_scope_idx ON tender.portal_submission_adapter_validations(portal_id,company_id,validated_at DESC);

CREATE OR REPLACE FUNCTION tender.protect_portal_submission_adapter_validation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'portal_submission_adapter_validation_immutable' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS protect_portal_submission_adapter_validation ON tender.portal_submission_adapter_validations;
CREATE TRIGGER protect_portal_submission_adapter_validation BEFORE UPDATE OR DELETE ON tender.portal_submission_adapter_validations FOR EACH ROW EXECUTE FUNCTION tender.protect_portal_submission_adapter_validation();

INSERT INTO tender.audit_events(action,metadata) VALUES('PORTAL_LOGIN_CONTRACT_VERIFIED',jsonb_build_object(
  'release','20260821-portal-regions-completion.19','hosts',jsonb_build_array('bieterzugang.deutsche-evergabe.de','www.meinauftrag.rib.de','www.vergabe24.de','www.evergabe.de','www.evergabe.bayern.de','www.dtvp.de'),'credentialChanged',false,'companyBindingChanged',false,'externalWrite',false));

COMMIT;
