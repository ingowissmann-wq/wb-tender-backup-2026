BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='15min';

INSERT INTO tender.context_backfill_runs(release_id,before_counts,external_submission_enabled)
VALUES('20260825-portal-family-host-profiles-128.3',jsonb_build_object(
  'needs_adapter_implementation',(SELECT count(*) FROM tender.portal_registry
    WHERE adapter_validation_status='NEEDS_ADAPTER_IMPLEMENTATION'),
  'classified_target_hosts',(SELECT count(*) FROM tender.portal_registry WHERE canonical_domain=ANY(ARRAY[
    'plattform.aumass.de','vergabe.landbw.de','vergabe.stadt-frankfurt.de',
    'www.ausschreibungen.ls.brandenburg.de','www.deutsches-ausschreibungsblatt.de',
    'www.evergabe.nrw.de','www.vergabe.metropoleruhr.de'
  ]::text[])),
  'physical_deletes',0
),false)
ON CONFLICT(release_id) DO NOTHING;

-- One adapter family legitimately has many independently allowlisted hosts.
-- The former (adapter_id,entrypoint_type) uniqueness prevented that model.
DROP INDEX IF EXISTS tender.portal_registry_adapter_entrypoint_unique;
CREATE UNIQUE INDEX IF NOT EXISTS portal_registry_adapter_host_entrypoint_unique
  ON tender.portal_registry(adapter_id,canonical_domain,entrypoint_type)
  WHERE adapter_id IS NOT NULL;

-- Official public pages verified 2026-08-25. Classification does not enable an
-- adapter and does not claim login or binding-submission acceptance.
UPDATE tender.portal_registry SET
  adapter_id='ai-vergabe-manager',adapter_version='2.0.0',
  portal_family_key='ai-vergabe-manager',login_strategy='BROWSER_FORM',
  document_strategy='NETSERVER_PUBLIC_ARCHIVE',
  bidder_area_url='https://vergabe.landbw.de/NetServer/index.jsp',
  authentication_entry_url='https://vergabe.landbw.de/NetServer/LoginControllerServlet?function=LoginForm&thContext=login',
  registration_entry_url='https://vergabe.landbw.de/NetServer/Register',
  capabilities=ARRAY['LOGIN_BROWSER_REQUIRED','CSRF_REQUIRED','JAVASCRIPT_REQUIRED',
    'TENDER_SEARCH_SUPPORTED','DIRECT_TENDER_LINK_SUPPORTED','DOCUMENT_LIST_SUPPORTED',
    'ZIP_DOWNLOAD_SUPPORTED','PUBLIC_DOCUMENTS_POSSIBLE'],
  updated_at=now()
WHERE canonical_domain='vergabe.landbw.de';

UPDATE tender.portal_registry SET
  adapter_id='ai-vergabe-manager',adapter_version='2.0.0',
  portal_family_key='ai-vergabe-manager',login_strategy='BROWSER_FORM',
  document_strategy='NETSERVER_PUBLIC_ARCHIVE',
  bidder_area_url='https://www.vergabe.stadt-frankfurt.de/NetServer/index.jsp',
  authentication_entry_url='https://www.vergabe.stadt-frankfurt.de/NetServer/LoginControllerServlet?function=LoginForm&thContext=login',
  registration_entry_url='https://www.vergabe.stadt-frankfurt.de/NetServer/LoginControllerServlet?function=LoginForm&thContext=login',
  capabilities=ARRAY['LOGIN_BROWSER_REQUIRED','CSRF_REQUIRED','JAVASCRIPT_REQUIRED',
    'TENDER_SEARCH_SUPPORTED','DIRECT_TENDER_LINK_SUPPORTED','DOCUMENT_LIST_SUPPORTED',
    'ZIP_DOWNLOAD_SUPPORTED','PUBLIC_DOCUMENTS_POSSIBLE'],
  updated_at=now()
WHERE canonical_domain='vergabe.stadt-frankfurt.de';

UPDATE tender.portal_registry SET
  adapter_id='ai-vergabe-manager',adapter_version='2.0.0',
  portal_family_key='ai-vergabe-manager',login_strategy='BROWSER_FORM',
  document_strategy='NETSERVER_PUBLIC_ARCHIVE',
  bidder_area_url='https://www.ausschreibungen.ls.brandenburg.de/NetServer/index.jsp',
  authentication_entry_url='https://www.ausschreibungen.ls.brandenburg.de/NetServer/LoginControllerServlet?function=LoginForm&thContext=login',
  registration_entry_url='https://www.ausschreibungen.ls.brandenburg.de/NetServer/Register',
  capabilities=ARRAY['LOGIN_BROWSER_REQUIRED','CSRF_REQUIRED','JAVASCRIPT_REQUIRED',
    'TENDER_SEARCH_SUPPORTED','DIRECT_TENDER_LINK_SUPPORTED','DOCUMENT_LIST_SUPPORTED',
    'ZIP_DOWNLOAD_SUPPORTED','PUBLIC_DOCUMENTS_POSSIBLE'],
  updated_at=now()
WHERE canonical_domain='www.ausschreibungen.ls.brandenburg.de';

UPDATE tender.portal_registry SET
  adapter_id='ai-vergabe-manager',adapter_version='2.0.0',
  portal_family_key='ai-vergabe-manager',login_strategy='BROWSER_FORM',
  document_strategy='AI_BIETERCOCKPIT',
  bidder_area_url='https://www.deutsches-ausschreibungsblatt.de/auftrag-finden/evergabe-fuer-bieter',
  authentication_entry_url='https://www.deutsches-ausschreibungsblatt.de/login',
  registration_entry_url='https://www.deutsches-ausschreibungsblatt.de/auftrag-finden/tarife-fuer-unternehmen/basis-registrierung',
  capabilities=ARRAY['LOGIN_BROWSER_REQUIRED','JAVASCRIPT_REQUIRED','MFA_POSSIBLE',
    'TENDER_SEARCH_SUPPORTED','DIRECT_TENDER_LINK_SUPPORTED','DOCUMENT_LIST_SUPPORTED',
    'ZIP_DOWNLOAD_SUPPORTED','PUBLIC_DOCUMENTS_POSSIBLE'],
  updated_at=now()
WHERE canonical_domain='www.deutsches-ausschreibungsblatt.de';

UPDATE tender.portal_registry SET
  adapter_id='cosinex',adapter_version='2.0.0',portal_family_key='cosinex-vmp',
  login_strategy='OIDC_BROWSER',document_strategy='VMP_PUBLIC_PROJECT',
  authentication_domains=array_append(array_remove(authentication_domains,'id.vergabeplattform.nrw'),'id.vergabeplattform.nrw'),
  bidder_area_url='https://www.evergabe.nrw.de/VMPCenter/company/welcome.do',
  authentication_entry_url='https://www.evergabe.nrw.de/VMPCenter/company/auth.do?method=show',
  registration_entry_url='https://www.evergabe.nrw.de/VMPCenter/company/registration/step1.do?method=step1',
  capabilities=ARRAY['LOGIN_OIDC','LOGIN_KEYCLOAK','CSRF_REQUIRED','JAVASCRIPT_REQUIRED',
    'MFA_POSSIBLE','TENDER_SEARCH_SUPPORTED','DIRECT_TENDER_LINK_SUPPORTED',
    'DOCUMENT_LIST_SUPPORTED','DIRECT_DOWNLOAD_SUPPORTED','ZIP_DOWNLOAD_SUPPORTED',
    'PUBLIC_DOCUMENTS_POSSIBLE'],updated_at=now()
WHERE canonical_domain='www.evergabe.nrw.de';

UPDATE tender.portal_registry SET
  adapter_id='cosinex',adapter_version='2.0.0',portal_family_key='cosinex-vmp',
  login_strategy='OIDC_BROWSER',document_strategy='VMP_PUBLIC_PROJECT',
  authentication_domains=array_append(array_remove(authentication_domains,'id.vergabeplattform.nrw'),'id.vergabeplattform.nrw'),
  bidder_area_url='https://www.vergabe.metropoleruhr.de/VMPSatellite/company/welcome.do',
  authentication_entry_url='https://www.vergabe.metropoleruhr.de/VMPSatellite/company/auth.do?method=show',
  registration_entry_url='https://www.evergabe.nrw.de/VMPCenter/company/registration/step1.do?method=step1',
  capabilities=ARRAY['LOGIN_OIDC','LOGIN_KEYCLOAK','CSRF_REQUIRED','JAVASCRIPT_REQUIRED',
    'MFA_POSSIBLE','TENDER_SEARCH_SUPPORTED','DIRECT_TENDER_LINK_SUPPORTED',
    'DOCUMENT_LIST_SUPPORTED','DIRECT_DOWNLOAD_SUPPORTED','ZIP_DOWNLOAD_SUPPORTED',
    'PUBLIC_DOCUMENTS_POSSIBLE'],updated_at=now()
WHERE canonical_domain='www.vergabe.metropoleruhr.de';

UPDATE tender.portal_registry SET
  adapter_id='aumass',adapter_version='2.0.0',portal_family_key='aumass',
  login_strategy='BROWSER_FORM_CAPTCHA_CONTINUATION',document_strategy='AUMASS_PUBLIC_TENDER',
  bidder_area_url='https://plattform.aumass.de/',
  authentication_entry_url='https://plattform.aumass.de/',
  registration_entry_url='https://plattform.aumass.de/Registration/Company?trf=free',
  capabilities=ARRAY['LOGIN_BROWSER_REQUIRED','CSRF_REQUIRED','JAVASCRIPT_REQUIRED',
    'CAPTCHA_POSSIBLE','TENDER_SEARCH_SUPPORTED','DIRECT_TENDER_LINK_SUPPORTED',
    'DOCUMENT_LIST_SUPPORTED','DIRECT_DOWNLOAD_SUPPORTED','ZIP_DOWNLOAD_SUPPORTED',
    'PUBLIC_DOCUMENTS_POSSIBLE'],updated_at=now()
WHERE canonical_domain='plattform.aumass.de';

-- All seven hosts completed a live, non-authenticated archive download with a
-- valid ZIP signature. The 332 MB AI-Bietercockpit archive was additionally
-- expanded under bounded limits and all 89 leaf documents passed ClamAV.
UPDATE tender.portal_registry SET adapter_validation_status='VALIDATED_READ_ONLY',updated_at=now()
WHERE canonical_domain IN(
  'vergabe.landbw.de','vergabe.stadt-frankfurt.de',
  'www.ausschreibungen.ls.brandenburg.de','www.evergabe.nrw.de',
  'www.vergabe.metropoleruhr.de','plattform.aumass.de','www.deutsches-ausschreibungsblatt.de'
);

WITH evidence(canonical_domain,evidence_url,evidence_label) AS(VALUES
  ('vergabe.landbw.de','https://vergabe.landbw.de/NetServer/TenderingProcedureDetails?function=_Details&TenderOID=54321-NetTender-1a0330393e0-2ef30ba9b1846c92','GET/browser ZIP 10044971 bytes sha256 aea31bba365cda4b7ad676ea3f5cf64f4d395cd4a6e95d663dc83b5290ffbbf5'),
  ('vergabe.stadt-frankfurt.de','https://www.vergabe.stadt-frankfurt.de/NetServer/TenderingProcedureDetails?function=_Details&TenderOID=54321-NetTender-1a037a18054-7c3a6df154fdb8b8','GET/browser ZIP 14680890 bytes sha256 f5768ba06ec443ea50e58bee3b85e5a61684e5773b19a6e15686e89990f22708'),
  ('www.ausschreibungen.ls.brandenburg.de','https://www.ausschreibungen.ls.brandenburg.de/NetServer/TenderingProcedureDetails?function=_Details&TenderOID=54321-Tender-19f5f3e0ce8-47281ec21b5e7918','GET/browser ZIP 23056419 bytes sha256 33b60bdb6e9b9f220bf000a2625d86c604c45bb3e208aa6bd42add3b562dfe37'),
  ('www.evergabe.nrw.de','https://www.evergabe.nrw.de/VMPSatellite/notice/CXS7YY3DYDMV2PU7/documents','GET ZIP 2502950 bytes sha256 8c940d32aa1ce6f9af842371d5fbf5a279a85c157de815652fa1e0f0563c4967'),
  ('www.vergabe.metropoleruhr.de','https://www.vergabe.metropoleruhr.de/VMPSatellite/notice/CXPSYYFDQQH/documents','GET ZIP 9164992 bytes sha256 45c6f49bd433151891a715eb11c4b13ad54fb79e2d0bd5961dd8eeebf257f3de'),
  ('plattform.aumass.de','https://plattform.aumass.de/Publication/TenderPreview?id=569312d1-f32b-49c0-aa6a-ed8e250d1f5c','GET ZIP 7676334 bytes sha256 9bcaa16d71da7bfefb2c4684b153ef7e2650a26dd4bfe7fffefb82fed84fe41f'),
  ('www.deutsches-ausschreibungsblatt.de','https://www.deutsches-ausschreibungsblatt.de/VN/X-BBS-2026-0112','GET/browser ZIP 332308908 bytes sha256 011a44b91faa7c25d8f25d7f4c7a5b235f6f79862c22e1afcf8d3c086b54dc25; 89/89 unique leaf files ClamAV CLEAN')
), upserted AS(
  INSERT INTO tender.portal_capability_profiles(portal_id,portal_type,profile_version,
    evidence_url,evidence_label,evidence_verified_at)
  SELECT portal.id,'E_VERGABEPORTAL',1,evidence.evidence_url,evidence.evidence_label,now()
  FROM evidence JOIN tender.portal_registry portal USING(canonical_domain)
  ON CONFLICT(portal_id) DO UPDATE SET portal_type='E_VERGABEPORTAL',
    evidence_url=excluded.evidence_url,evidence_label=excluded.evidence_label,
    evidence_verified_at=excluded.evidence_verified_at,updated_at=now()
  RETURNING id,portal_id,evidence_url,evidence_label
), capabilities AS(
  SELECT profile.id profile_id,portal.canonical_domain,feature.feature_key,
    CASE WHEN feature.feature_key IN('DISCOVERY','DOCUMENT_DOWNLOAD') THEN true ELSE false END accepted,
    CASE WHEN feature.feature_key IN('LOGIN','MFA') THEN true
      WHEN feature.feature_key IN('DISCOVERY','DOCUMENT_DOWNLOAD') THEN true ELSE false END implemented,
    CASE WHEN feature.feature_key IN('LOGIN','MFA') THEN portal.authentication_entry_url ELSE profile.evidence_url END evidence_url,
    CASE WHEN feature.feature_key IN('LOGIN','MFA') THEN
      'Read-only browser canary 2026-08-25: login entry and semantic fields discovered with exact redirect allowlist; no credentials submitted; authenticated login remains untested.'
      ELSE profile.evidence_label END evidence_label
  FROM upserted profile
  JOIN tender.portal_registry portal ON portal.id=profile.portal_id
  CROSS JOIN (VALUES('DISCOVERY'),('DOCUMENT_DOWNLOAD'),('NOTICES'),('AMENDMENTS'),
    ('LOGIN'),('MFA'),('PARTICIPATION'),('SUBMISSION_PREFLIGHT'),('SUBMISSION'),('MONITORING')) feature(feature_key)
)
INSERT INTO tender.portal_capability_features(profile_id,feature_key,portal_support,
  autopilot_supported,actively_configured,production_tested,browser_acceptance_passed,
  evidence_url,evidence_note,verified_at)
SELECT profile_id,feature_key,'SUPPORTED',implemented,implemented,accepted,accepted,
  evidence_url,CASE WHEN accepted OR implemented THEN evidence_label ELSE
    'Portal feature exists, but WB adapter has no successful host-specific live acceptance.' END,now()
FROM capabilities
ON CONFLICT(profile_id,feature_key) DO UPDATE SET
  portal_support=excluded.portal_support,autopilot_supported=excluded.autopilot_supported,
  actively_configured=excluded.actively_configured,production_tested=excluded.production_tested,
  browser_acceptance_passed=excluded.browser_acceptance_passed,evidence_url=excluded.evidence_url,
  evidence_note=excluded.evidence_note,verified_at=excluded.verified_at;

CREATE OR REPLACE VIEW tender.current_portal_host_capability_truth
WITH (security_barrier=true,security_invoker=true) AS
SELECT portal.id portal_id,portal.canonical_domain,portal.portal_family_key,
  feature.feature_key,feature.portal_support,feature.autopilot_supported,
  feature.actively_configured,feature.production_tested,feature.browser_acceptance_passed,
  feature.evidence_url,feature.evidence_note,feature.verified_at
FROM tender.portal_registry portal
JOIN tender.portal_capability_profiles profile ON profile.portal_id=portal.id
JOIN tender.portal_capability_features feature ON feature.profile_id=profile.id;

COMMENT ON VIEW tender.current_portal_host_capability_truth IS
  'Host-specific capability evidence. Never infer one portal variant from another host in the same software family.';

UPDATE tender.context_backfill_runs
SET finished_at=now(),after_counts=jsonb_build_object(
  'classified_target_hosts',(SELECT count(*) FROM tender.portal_registry WHERE adapter_id IN(
    'ai-vergabe-manager','cosinex','aumass'
  ) AND canonical_domain=ANY(ARRAY[
    'plattform.aumass.de','vergabe.landbw.de','vergabe.stadt-frankfurt.de',
    'www.ausschreibungen.ls.brandenburg.de','www.deutsches-ausschreibungsblatt.de',
    'www.evergabe.nrw.de','www.vergabe.metropoleruhr.de'
  ]::text[])),
  'validated_read_only_hosts',(SELECT count(*) FROM tender.portal_registry
    WHERE adapter_validation_status='VALIDATED_READ_ONLY' AND canonical_domain=ANY(ARRAY[
      'plattform.aumass.de','vergabe.landbw.de','vergabe.stadt-frankfurt.de',
      'www.ausschreibungen.ls.brandenburg.de','www.evergabe.nrw.de',
      'www.vergabe.metropoleruhr.de','www.deutsches-ausschreibungsblatt.de'
    ]::text[])),
  'enabled_by_migration',0,'external_submission_enabled',false,'physical_deletes',0
)
WHERE release_id='20260825-portal-family-host-profiles-128.3';

INSERT INTO app.schema_migrations(version,description)
VALUES('0128-portal-family-host-profiles',
  'Classify seven observed portal hosts into reusable adapter families without enabling external actions')
ON CONFLICT(version) DO NOTHING;

COMMIT;
