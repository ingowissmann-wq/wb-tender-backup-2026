BEGIN;
SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:munich-ai-netserver-public:144',0));

INSERT INTO tender.portal_families(family_key,display_name,adapter_id,adapter_version)
VALUES('muenchen.de','Historische hostbezogene München-Zuordnung','unknown-afc1dd38a70d','0.1.0')
ON CONFLICT(family_key) DO NOTHING;

UPDATE tender.portal_family_domains domain SET portal_family_id=family.id,allowed_by_adapter=false
FROM tender.portal_families family
WHERE domain.domain='vergabe.muenchen.de' AND domain.role='TARGET' AND family.family_key='muenchen.de';

UPDATE tender.portal_family_domains SET allowed_by_adapter=false
WHERE domain='vergabe.muenchen.de' AND role='DOWNLOAD';

UPDATE tender.portal_registry SET adapter_id='unknown-afc1dd38a70d',adapter_version='0.1.0',
  adapter_enabled=false,adapter_validation_status='NO_ACTIVE_TENDER_FOR_VALIDATION',
  portal_family_key='unknown-afc1dd38a70d',capabilities=ARRAY[]::text[],login_strategy='NONE',
  document_strategy='NONE',download_domains=ARRAY[]::text[],allowed_return_paths=ARRAY[]::text[],updated_at=now()
WHERE id='71c824fd-1775-47f8-ae48-2d1c73b5e851' AND adapter_id='ai-vergabe-manager';

UPDATE tender.portal_connector_adapters SET enabled=false,validation_status='PARTIALLY_VALIDATED',updated_at=now()
WHERE adapter_id='ai-vergabe-manager' AND adapter_version='2.0.0-public-netserver' AND canonical_domain='vergabe.muenchen.de';

UPDATE tender.portal_capability_features feature SET portal_support='UNKNOWN',autopilot_supported=false,
  actively_configured=false,production_tested=false,browser_acceptance_passed=false
FROM tender.portal_capability_profiles profile
WHERE feature.profile_id=profile.id AND profile.portal_id='71c824fd-1775-47f8-ae48-2d1c73b5e851'
  AND feature.feature_key IN('BROWSER_AUTOMATION','DOCUMENT_DOWNLOAD','PROCUREMENT_DOCUMENTS','ZIP');

INSERT INTO tender.audit_events(action,metadata) VALUES('MUNICH_AI_NETSERVER_PUBLIC_ADAPTER_ROLLED_BACK',jsonb_build_object(
  'release','20260826-munich-ai-netserver-public-144.1','portalId','71c824fd-1775-47f8-ae48-2d1c73b5e851',
  'configurationDisabled',true,'evidenceRetained',true,'physicalDeletes',0,'externalWrite',false,'externalSubmission',false));
INSERT INTO app.schema_migrations(version,description)
VALUES('0144-munich-ai-netserver-public-adapter-rollback','Disable Munich public NetServer adapter while retaining evidence and audit history')
ON CONFLICT(version) DO NOTHING;
COMMIT;
