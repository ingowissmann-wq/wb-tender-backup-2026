BEGIN;
SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='10min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:eu-etenders-family-adapters:150',0));

DO $$ BEGIN
  IF (SELECT count(*) FROM tender.portal_registry WHERE
      (id='7b624353-e099-4e6f-9a50-6a778e5ed892' AND canonical_domain='ec.europa.eu' AND adapter_id='unknown-1fb9978eb417') OR
      (id='003f1d5d-30ee-4b53-b020-9bec6c416ba5' AND canonical_domain='www.etenders.gov.ie' AND adapter_id='unknown-238c4d9083f6'))<>2
  THEN RAISE EXCEPTION 'eu_etenders_exact_registry_precondition_failed'; END IF;
END $$;

INSERT INTO tender.portal_families(family_key,display_name,adapter_id,adapter_version) VALUES
 ('eu-funding-tenders','EU Funding & Tenders / eSubmission','eu-funding-tenders','2.0.0'),
 ('etenders-ireland','eTenders Ireland / European Dynamics EPPS','etenders-ireland','2.0.0')
ON CONFLICT(family_key) DO UPDATE SET display_name=excluded.display_name,adapter_id=excluded.adapter_id,adapter_version=excluded.adapter_version;

WITH domains(family_key,domain,role) AS(VALUES
 ('eu-funding-tenders','ec.europa.eu','TARGET'),('eu-funding-tenders','ec.europa.eu','DOWNLOAD'),
 ('eu-funding-tenders','ecas.ec.europa.eu','AUTHENTICATION'),('eu-funding-tenders','webgate.ec.europa.eu','DOWNLOAD'),
 ('etenders-ireland','www.etenders.gov.ie','TARGET'),('etenders-ireland','www.etenders.gov.ie','AUTHENTICATION'),
 ('etenders-ireland','www.etenders.gov.ie','DOWNLOAD'))
INSERT INTO tender.portal_family_domains(portal_family_id,domain,role,allowed_by_adapter)
SELECT family.id,domains.domain,domains.role,true FROM domains JOIN tender.portal_families family USING(family_key)
ON CONFLICT(domain,role) DO UPDATE SET portal_family_id=excluded.portal_family_id,allowed_by_adapter=true;

INSERT INTO tender.portal_adapters(portal_code,name,mode,supported_actions,authentication_type,feature_flag,kill_switch) VALUES
 ('eu-funding-tenders','EU Funding & Tenders / eSubmission','READ_ONLY_PORTAL_AUTOMATION',ARRAY['DOWNLOAD','MONITOR'],'EU_LOGIN_SSO','TENDER_PORTAL_READ',true),
 ('etenders-ireland','eTenders Ireland / European Dynamics EPPS','READ_ONLY_PORTAL_AUTOMATION',ARRAY['DOWNLOAD','MONITOR'],'CAS_BROWSER','TENDER_PORTAL_READ',true)
ON CONFLICT(portal_code) DO UPDATE SET name=excluded.name,mode=excluded.mode,supported_actions=excluded.supported_actions,
 authentication_type=excluded.authentication_type,feature_flag=excluded.feature_flag,kill_switch=true,last_error_code=NULL;

INSERT INTO tender.portal_connector_adapters(adapter_id,adapter_version,contract_version,canonical_domain,
 authentication_domains,download_domains,capabilities,login_strategy,document_strategy,timeout_profile,
 rate_limit_profile,session_profile,allowed_return_paths,max_redirects,enabled,validation_status,last_verified_at) VALUES
 ('eu-funding-tenders','2.0.0','2.0.0','ec.europa.eu',ARRAY['ecas.ec.europa.eu'],ARRAY['ec.europa.eu','webgate.ec.europa.eu'],
  ARRAY['LOGIN_SSO','MFA_POSSIBLE','JAVASCRIPT_REQUIRED','DIRECT_TENDER_LINK_SUPPORTED','DOCUMENT_LIST_SUPPORTED','DIRECT_DOWNLOAD_SUPPORTED','PUBLIC_DOCUMENTS_POSSIBLE','AUTHENTICATED_DOCUMENTS_REQUIRED'],
  'EU_LOGIN_SSO','FUNDING_TENDERS_TED_ESUBMISSION','{"LOGIN":60000,"MFA":180000,"DOWNLOAD":120000}'::jsonb,
  '{"maxConcurrent":1}'::jsonb,'{"encrypted":true,"companyScoped":true}'::jsonb,
  ARRAY['/info/funding-tenders/opportunities/portal/','/digit/opsys/esubmission-fo-ui/'],8,true,'PARTIALLY_VALIDATED',now()),
 ('etenders-ireland','2.0.0','2.0.0','www.etenders.gov.ie',ARRAY['www.etenders.gov.ie'],ARRAY['www.etenders.gov.ie'],
  ARRAY['LOGIN_BROWSER_REQUIRED','CSRF_REQUIRED','JAVASCRIPT_REQUIRED','MFA_POSSIBLE','CAPTCHA_POSSIBLE','DIRECT_TENDER_LINK_SUPPORTED','DOCUMENT_LIST_SUPPORTED','DIRECT_DOWNLOAD_SUPPORTED','PUBLIC_DOCUMENTS_POSSIBLE','AUTHENTICATED_DOCUMENTS_REQUIRED'],
  'CAS_BROWSER','EUROPEAN_DYNAMICS_EPPS','{"LOGIN":60000,"MFA":180000,"DOWNLOAD":120000}'::jsonb,
  '{"maxConcurrent":1}'::jsonb,'{"encrypted":true,"companyScoped":true}'::jsonb,
  ARRAY['/epps/','/cas/'],8,true,'PARTIALLY_VALIDATED',now())
ON CONFLICT(adapter_id,adapter_version) DO UPDATE SET contract_version=excluded.contract_version,
 canonical_domain=excluded.canonical_domain,authentication_domains=excluded.authentication_domains,
 download_domains=excluded.download_domains,capabilities=excluded.capabilities,login_strategy=excluded.login_strategy,
 document_strategy=excluded.document_strategy,timeout_profile=excluded.timeout_profile,rate_limit_profile=excluded.rate_limit_profile,
 session_profile=excluded.session_profile,allowed_return_paths=excluded.allowed_return_paths,max_redirects=excluded.max_redirects,
 enabled=true,validation_status='PARTIALLY_VALIDATED',last_verified_at=now();

UPDATE tender.portal_registry SET adapter_id='eu-funding-tenders',adapter_version='2.0.0',adapter_enabled=true,
 adapter_validation_status='INTERNAL_CONTRACT_VALIDATED',portal_family_key='eu-funding-tenders',
 login_strategy='EU_LOGIN_SSO',document_strategy='FUNDING_TENDERS_TED_ESUBMISSION',
 authentication_domains=ARRAY['ecas.ec.europa.eu'],download_domains=ARRAY['ec.europa.eu','webgate.ec.europa.eu'],
 authentication_entry_url='https://ecas.ec.europa.eu/cas/login',
 registration_entry_url='https://ecas.ec.europa.eu/cas/eim/external/register.cgi',
 capabilities=ARRAY['LOGIN_SSO','MFA_POSSIBLE','JAVASCRIPT_REQUIRED','DIRECT_TENDER_LINK_SUPPORTED','DOCUMENT_LIST_SUPPORTED','DIRECT_DOWNLOAD_SUPPORTED','PUBLIC_DOCUMENTS_POSSIBLE','AUTHENTICATED_DOCUMENTS_REQUIRED'],
 last_error_code=NULL,updated_at=now()
WHERE id='7b624353-e099-4e6f-9a50-6a778e5ed892' AND canonical_domain='ec.europa.eu';

UPDATE tender.portal_registry SET adapter_id='etenders-ireland',adapter_version='2.0.0',adapter_enabled=true,
 adapter_validation_status='INTERNAL_CONTRACT_VALIDATED',portal_family_key='etenders-ireland',
 login_strategy='CAS_BROWSER',document_strategy='EUROPEAN_DYNAMICS_EPPS',
 authentication_domains=ARRAY['www.etenders.gov.ie'],download_domains=ARRAY['www.etenders.gov.ie'],
 bidder_area_url='https://www.etenders.gov.ie/epps/home.do',
 authentication_entry_url='https://www.etenders.gov.ie/cas/login',
 registration_entry_url='https://www.etenders.gov.ie/epps/registerEOOrg.do',
 capabilities=ARRAY['LOGIN_BROWSER_REQUIRED','CSRF_REQUIRED','JAVASCRIPT_REQUIRED','MFA_POSSIBLE','CAPTCHA_POSSIBLE','DIRECT_TENDER_LINK_SUPPORTED','DOCUMENT_LIST_SUPPORTED','DIRECT_DOWNLOAD_SUPPORTED','PUBLIC_DOCUMENTS_POSSIBLE','AUTHENTICATED_DOCUMENTS_REQUIRED'],
 last_error_code=NULL,updated_at=now()
WHERE id='003f1d5d-30ee-4b53-b020-9bec6c416ba5' AND canonical_domain='www.etenders.gov.ie';

WITH target(portal_id,portal_type,evidence_url,evidence_label) AS(VALUES
 ('7b624353-e099-4e6f-9a50-6a778e5ed892'::uuid,'E_VERGABEPORTAL','https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/how-to-participate/how-to-participate/2','Official EU operator workflow: EU Login, PIC, TED eTendering, eSubmission and Submission Receipt; internal replay/contract only'),
 ('003f1d5d-30ee-4b53-b020-9bec6c416ba5'::uuid,'E_VERGABEPORTAL','https://www.etenders.gov.ie/epps/home.do','Official Irish OGP eTenders EPPS/CAS workflow; internal replay/contract only'))
INSERT INTO tender.portal_capability_profiles(portal_id,portal_type,profile_version,evidence_url,evidence_label,evidence_verified_at)
SELECT portal_id,portal_type,1,evidence_url,evidence_label,now() FROM target
ON CONFLICT(portal_id) DO UPDATE SET portal_type=excluded.portal_type,profile_version=tender.portal_capability_profiles.profile_version+1,
 evidence_url=excluded.evidence_url,evidence_label=excluded.evidence_label,evidence_verified_at=now(),updated_at=now();

WITH profiles AS(SELECT id,portal_id,evidence_url,evidence_label FROM tender.portal_capability_profiles
 WHERE portal_id IN('7b624353-e099-4e6f-9a50-6a778e5ed892','003f1d5d-30ee-4b53-b020-9bec6c416ba5')),
 features(feature_key) AS(VALUES('DISCOVERY'),('DOCUMENT_DOWNLOAD'),('NOTICES'),('AMENDMENTS'),('LOGIN'),('MFA'),
 ('PARTICIPATION'),('SUBMISSION_PREFLIGHT'),('SUBMISSION'),('MONITORING'))
INSERT INTO tender.portal_capability_features(profile_id,feature_key,portal_support,autopilot_supported,
 actively_configured,production_tested,browser_acceptance_passed,evidence_url,evidence_note,verified_at)
SELECT profiles.id,features.feature_key,'SUPPORTED',true,true,false,false,profiles.evidence_url,
 profiles.evidence_label||'; EXTERNAL_VALIDATION_PENDING',now() FROM profiles CROSS JOIN features
ON CONFLICT(profile_id,feature_key) DO UPDATE SET portal_support='SUPPORTED',autopilot_supported=true,
 actively_configured=true,production_tested=false,browser_acceptance_passed=false,evidence_url=excluded.evidence_url,
 evidence_note=excluded.evidence_note,verified_at=now();

INSERT INTO tender.audit_events(action,metadata) VALUES('EU_ETENDERS_FAMILY_ADAPTERS_INSTALLED',jsonb_build_object(
 'release','20260826-eu-etenders-family-adapters-150.1','families',jsonb_build_array('eu-funding-tenders','etenders-ireland'),
 'contractVersion','2.0.0','internalReplayPassed',true,'externalValidation','PENDING',
 'bindingSubmissionEnabled',false,'physicalDeletes',0,'externalWrite',false,'externalSubmission',false,'transmitted',false));
INSERT INTO app.schema_migrations(version,description) VALUES('0150-eu-etenders-family-adapters',
 'Install internally simulated EU Funding Tenders and Ireland eTenders family adapters while external validation and binding submission remain disabled')
ON CONFLICT(version) DO NOTHING;
COMMIT;
