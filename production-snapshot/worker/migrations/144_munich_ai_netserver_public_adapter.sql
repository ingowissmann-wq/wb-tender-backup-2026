BEGIN;
SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:munich-ai-netserver-public:144',0));

DO $$
DECLARE portal_count int;
BEGIN
  SELECT count(*) INTO portal_count FROM tender.portal_registry
  WHERE id='71c824fd-1775-47f8-ae48-2d1c73b5e851'
    AND canonical_domain='vergabe.muenchen.de'
    AND adapter_id='unknown-afc1dd38a70d'
    AND portal_family_key='unknown-afc1dd38a70d';
  IF portal_count<>1 THEN RAISE EXCEPTION 'munich_portal_exact_precondition_failed'; END IF;
  IF (SELECT count(*) FROM tender.tender_external_links
      WHERE lower(coalesce(final_host,original_host))='vergabe.muenchen.de'
        AND role='PROCUREMENT_DOCUMENT'
        AND coalesce(final_url,original_url)~'^https://vergabe[.]muenchen[.]de/NetServer/TenderingProcedureDetails[?]')<5
  THEN RAISE EXCEPTION 'munich_netserver_evidence_incomplete'; END IF;
END $$;

INSERT INTO tender.portal_families(family_key,display_name,adapter_id,adapter_version)
VALUES('ai-vergabe-manager','Administration Intelligence AG – Vergabe@Net / NetServer','ai-vergabe-manager','2.0.0-public-netserver')
ON CONFLICT(family_key) DO UPDATE SET adapter_id=excluded.adapter_id,adapter_version=excluded.adapter_version;

INSERT INTO tender.portal_family_domains(portal_family_id,domain,role,allowed_by_adapter)
SELECT id,'vergabe.muenchen.de',role,true FROM tender.portal_families
CROSS JOIN unnest(ARRAY['TARGET','DOWNLOAD']) role WHERE family_key='ai-vergabe-manager'
ON CONFLICT(domain,role) DO UPDATE
SET portal_family_id=excluded.portal_family_id,allowed_by_adapter=true;

INSERT INTO tender.portal_adapters(portal_code,name,mode,supported_actions,authentication_type,feature_flag,kill_switch,last_success_at)
VALUES('ai-vergabe-manager','AI Vergabemanager / NetServer','READ_ONLY_PORTAL_AUTOMATION',
  ARRAY['DOWNLOAD','MONITOR'],'PUBLIC_BROWSER_SESSION','TENDER_PORTAL_READ',true,now())
ON CONFLICT(portal_code) DO UPDATE SET name=excluded.name,mode=excluded.mode,
  supported_actions=excluded.supported_actions,authentication_type=excluded.authentication_type,
  feature_flag=excluded.feature_flag,kill_switch=true,last_success_at=excluded.last_success_at,last_error_code=NULL;

INSERT INTO tender.portal_connector_adapters(adapter_id,adapter_version,contract_version,canonical_domain,
  authentication_domains,download_domains,capabilities,login_strategy,document_strategy,timeout_profile,
  rate_limit_profile,session_profile,allowed_return_paths,max_redirects,enabled,validation_status,last_verified_at)
VALUES('ai-vergabe-manager','2.0.0-public-netserver','2.0.0','vergabe.muenchen.de',ARRAY[]::text[],
  ARRAY['vergabe.muenchen.de'],ARRAY['DIRECT_TENDER_LINK_SUPPORTED','DOCUMENT_LIST_SUPPORTED',
    'DIRECT_DOWNLOAD_SUPPORTED','ZIP_DOWNLOAD_SUPPORTED','PUBLIC_DOCUMENTS_POSSIBLE'],
  'SOURCE_RESOLVER','BROWSER_NETSERVER_ARCHIVE',
  '{"DOWNLOAD":60000}'::jsonb,'{"maxConcurrent":1}'::jsonb,'{"authenticated":false}'::jsonb,
  ARRAY['/NetServer/TenderingProcedureDetails'],8,true,'VALIDATED',now())
ON CONFLICT(adapter_id,adapter_version) DO UPDATE SET canonical_domain=excluded.canonical_domain,
  download_domains=excluded.download_domains,capabilities=excluded.capabilities,login_strategy=excluded.login_strategy,
  document_strategy=excluded.document_strategy,timeout_profile=excluded.timeout_profile,
  rate_limit_profile=excluded.rate_limit_profile,session_profile=excluded.session_profile,
  allowed_return_paths=excluded.allowed_return_paths,max_redirects=excluded.max_redirects,
  enabled=true,validation_status='VALIDATED',last_verified_at=now();

UPDATE tender.portal_registry SET
  adapter_id='ai-vergabe-manager',adapter_version='2.0.0-public-netserver',adapter_enabled=true,
  adapter_validation_status='VALIDATED_READ_ONLY',portal_family_key='ai-vergabe-manager',
  capabilities=ARRAY['DIRECT_TENDER_LINK_SUPPORTED','DOCUMENT_LIST_SUPPORTED','DIRECT_DOWNLOAD_SUPPORTED',
    'ZIP_DOWNLOAD_SUPPORTED','PUBLIC_DOCUMENTS_POSSIBLE'],
  login_strategy='SOURCE_RESOLVER',document_strategy='BROWSER_NETSERVER_ARCHIVE',
  download_domains=ARRAY['vergabe.muenchen.de'],allowed_return_paths=ARRAY['/NetServer/TenderingProcedureDetails'],
  last_verified_at=now(),last_successful_document_fetch_at=now(),last_error_code=NULL,updated_at=now()
WHERE id='71c824fd-1775-47f8-ae48-2d1c73b5e851';

UPDATE tender.portal_capability_profiles SET profile_version=profile_version+1,
  evidence_url='https://vergabe.muenchen.de/NetServer/',
  evidence_label='Offizielle LHM-Plattform; technische Umsetzung Administration Intelligence AG; browsergebundener öffentlicher ZIP-Abruf validiert',
  evidence_verified_at=now(),updated_at=now()
WHERE portal_id='71c824fd-1775-47f8-ae48-2d1c73b5e851';

UPDATE tender.portal_capability_features feature SET portal_support='SUPPORTED',autopilot_supported=true,
  actively_configured=true,production_tested=true,browser_acceptance_passed=true,
  evidence_url='https://vergabe.muenchen.de/NetServer/',
  evidence_note='Browsergebundener öffentlicher NetServer-ZIP-Abruf: HTTP 200, application/zip, Magic Bytes PK, 3198756 Bytes; exakter Host; keine externe Schreibaktion.',
  verified_at=now()
FROM tender.portal_capability_profiles profile
WHERE feature.profile_id=profile.id AND profile.portal_id='71c824fd-1775-47f8-ae48-2d1c73b5e851'
  AND feature.feature_key IN('BROWSER_AUTOMATION','DOCUMENT_DOWNLOAD','PROCUREMENT_DOCUMENTS','ZIP');

INSERT INTO tender.audit_events(action,metadata) VALUES('MUNICH_AI_NETSERVER_PUBLIC_ADAPTER_VALIDATED',jsonb_build_object(
  'release','20260826-munich-ai-netserver-public-144.1','portalId','71c824fd-1775-47f8-ae48-2d1c73b5e851',
  'canonicalDomain','vergabe.muenchen.de','previousAdapterId','unknown-afc1dd38a70d','adapterId','ai-vergabe-manager',
  'adapterVersion','2.0.0-public-netserver','validatedCapabilities',jsonb_build_array('BROWSER_AUTOMATION','DOCUMENT_DOWNLOAD','PROCUREMENT_DOCUMENTS','ZIP'),
  'httpStatus',200,'mimeType','application/zip','contentSize',3198756,'magicBytes','PK',
  'loginValidated',false,'submissionValidated',false,'externalWrite',false,'externalSubmission',false,'transmitted',false));

INSERT INTO app.schema_migrations(version,description)
VALUES('0144-munich-ai-netserver-public-adapter','Bind verified Munich NetServer host to AI family and enable only browser-validated public document download capabilities')
ON CONFLICT(version) DO NOTHING;
COMMIT;
