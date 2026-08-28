BEGIN;

-- Authoritative operator migration verified on 2026-08-22 from the official
-- deutsche-evergabe.de "Für Unternehmen" link, the current login/register
-- pages, the unauthenticated dashboard redirect, and the valid Healy Hudson
-- wildcard certificate.  The historical canonical portal identity is kept so
-- every existing portal/account/company/tender/document/audit binding remains
-- stable; only its current authentication endpoints and connector version move.
UPDATE tender.portal_registry SET
  adapter_version='1.2.0-operator-host-migration',
  adapter_validation_status='LOGIN_REQUIRED',
  authentication_entry_url='https://portal.deutsche-evergabe.de/Account/Login',
  bidder_area_url='https://portal.deutsche-evergabe.de/Dashboards/Dashboard',
  registration_entry_url='https://portal.deutsche-evergabe.de/Account/Register',
  authentication_domains=ARRAY['bieterzugang.deutsche-evergabe.de','portal.deutsche-evergabe.de'],
  allowed_subdomains=ARRAY['bieterzugang.deutsche-evergabe.de','portal.deutsche-evergabe.de'],
  allowed_return_paths=ARRAY['/evergabe.bieter/','/Account/Login','/Account/Register','/Dashboards/'],
  login_strategy='BROWSER',document_strategy='NONE',
  capabilities=ARRAY['LOGIN_HTTP_FORM','CSRF_REQUIRED','BIDDER_LOGIN','AUTHENTICATED_DOCUMENTS_REQUIRED'],
  last_error_code=NULL,entry_links_verified_at=now(),last_verified_at=now(),updated_at=now()
WHERE canonical_domain='bieterzugang.deutsche-evergabe.de';

DO $$ BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM tender.portal_registry
    WHERE canonical_domain='bieterzugang.deutsche-evergabe.de'
      AND authentication_entry_url='https://portal.deutsche-evergabe.de/Account/Login'
      AND bidder_area_url='https://portal.deutsche-evergabe.de/Dashboards/Dashboard'
      AND registration_entry_url='https://portal.deutsche-evergabe.de/Account/Register'
      AND adapter_version='1.2.0-operator-host-migration'
  ) THEN RAISE EXCEPTION 'deutsche_evergabe_historical_scope_migration_failed'; END IF;
END $$;

UPDATE tender.portal_registry SET
  adapter_version='1.1.0-operator-current',
  authentication_entry_url='https://portal.deutsche-evergabe.de/Account/Login',
  bidder_area_url='https://portal.deutsche-evergabe.de/Dashboards/Dashboard',
  registration_entry_url='https://portal.deutsche-evergabe.de/Account/Register',
  authentication_domains=(SELECT ARRAY(SELECT DISTINCT host FROM unnest(coalesce(authentication_domains,'{}'::text[])||ARRAY['portal.deutsche-evergabe.de']) host ORDER BY host)),
  allowed_subdomains=(SELECT ARRAY(SELECT DISTINCT host FROM unnest(coalesce(allowed_subdomains,'{}'::text[])||ARRAY['portal.deutsche-evergabe.de']) host ORDER BY host)),
  allowed_return_paths=(SELECT ARRAY(SELECT DISTINCT path FROM unnest(coalesce(allowed_return_paths,'{}'::text[])||ARRAY['/Account/Login','/Account/Register','/Dashboards/']) path ORDER BY path)),
  login_strategy='BROWSER',entry_links_verified_at=now(),last_verified_at=now(),updated_at=now()
WHERE canonical_domain='www.deutsche-evergabe.de';

DO $$ BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM tender.portal_registry
    WHERE canonical_domain='www.deutsche-evergabe.de'
      AND authentication_entry_url='https://portal.deutsche-evergabe.de/Account/Login'
      AND bidder_area_url='https://portal.deutsche-evergabe.de/Dashboards/Dashboard'
      AND registration_entry_url='https://portal.deutsche-evergabe.de/Account/Register'
      AND adapter_version='1.1.0-operator-current'
  ) THEN RAISE EXCEPTION 'deutsche_evergabe_current_scope_migration_failed'; END IF;
END $$;

INSERT INTO tender.portal_connector_adapters(
  adapter_id,adapter_version,contract_version,canonical_domain,
  authentication_domains,download_domains,capabilities,login_strategy,
  document_strategy,allowed_return_paths,enabled,validation_status,last_verified_at
)
VALUES(
  'deutsche-evergabe','1.2.0-operator-host-migration','2.1.0','bieterzugang.deutsche-evergabe.de',
  ARRAY['bieterzugang.deutsche-evergabe.de','portal.deutsche-evergabe.de'],ARRAY[]::text[],
  ARRAY['LOGIN_HTTP_FORM','CSRF_REQUIRED','BIDDER_LOGIN','AUTHENTICATED_DOCUMENTS_REQUIRED'],
  'BROWSER','NONE',ARRAY['/evergabe.bieter/','/Account/Login','/Account/Register','/Dashboards/'],
  true,'CREDENTIAL_REQUIRED',now()
)
ON CONFLICT(canonical_domain,adapter_version) DO UPDATE SET
  adapter_id=excluded.adapter_id,contract_version=excluded.contract_version,
  authentication_domains=excluded.authentication_domains,download_domains=excluded.download_domains,
  capabilities=excluded.capabilities,login_strategy=excluded.login_strategy,
  document_strategy=excluded.document_strategy,allowed_return_paths=excluded.allowed_return_paths,
  enabled=true,validation_status='CREDENTIAL_REQUIRED',last_verified_at=now(),updated_at=now();

INSERT INTO tender.portal_connector_adapters(
  adapter_id,adapter_version,contract_version,canonical_domain,
  authentication_domains,download_domains,capabilities,login_strategy,
  document_strategy,allowed_return_paths,enabled,validation_status,last_verified_at
)
SELECT adapter_id,'1.1.0-operator-current','2.1.0',canonical_domain,
  authentication_domains,download_domains,capabilities,'BROWSER',document_strategy,
  allowed_return_paths,true,'VALIDATED',now()
FROM tender.portal_registry WHERE canonical_domain='www.deutsche-evergabe.de'
ON CONFLICT(canonical_domain,adapter_version) DO UPDATE SET
  adapter_id=excluded.adapter_id,contract_version=excluded.contract_version,
  authentication_domains=excluded.authentication_domains,download_domains=excluded.download_domains,
  capabilities=excluded.capabilities,login_strategy=excluded.login_strategy,
  document_strategy=excluded.document_strategy,allowed_return_paths=excluded.allowed_return_paths,
  enabled=true,validation_status='VALIDATED',last_verified_at=now(),updated_at=now();

UPDATE tender.portal_capability_features feature SET
  portal_support='SUPPORTED',autopilot_supported=true,actively_configured=true,
  production_tested=false,browser_acceptance_passed=false,
  evidence_url='https://portal.deutsche-evergabe.de/Account/Login',
  evidence_note='Offizielle Betreiber-Hostmigration, TLS-Zertifikat, Loginformular und Dashboard-Redirect am 2026-08-22 verifiziert; gesellschaftsgebundener Login steht noch aus.',
  verified_at=now()
FROM tender.portal_capability_profiles profile JOIN tender.portal_registry portal ON portal.id=profile.portal_id
WHERE feature.profile_id=profile.id
  AND portal.canonical_domain='bieterzugang.deutsche-evergabe.de'
  AND feature.feature_key='LOGIN';

INSERT INTO tender.audit_events(action,metadata)
VALUES('DEUTSCHE_EVERGABE_OPERATOR_HOST_MIGRATED',jsonb_build_object(
  'release','20260822-deutsche-evergabe-operator-host.40',
  'historicalCanonicalHost','bieterzugang.deutsche-evergabe.de',
  'currentAuthenticationHost','portal.deutsche-evergabe.de',
  'officialEntryHost','deutsche-evergabe.de',
  'credentialChanged',false,'companyBindingChanged',false,
  'portalIdentityChanged',false,'submissionEnabled',false,
  'externalWrite',false,'transmitted',false));

COMMIT;
