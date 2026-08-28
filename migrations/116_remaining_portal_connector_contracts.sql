BEGIN;

-- Align the validated TED discovery connector with the registry's canonical
-- adapter id. TED remains a notice/discovery service, never a submission portal.
UPDATE tender.portal_connector_adapters connector SET
  adapter_id='ted-discovery',
  capabilities=ARRAY['DISCOVERY','NOTICE_VIEW','HISTORY','PUBLIC_DOCUMENTS_POSSIBLE','DIRECT_TENDER_LINK_SUPPORTED'],
  login_strategy='SOURCE_RESOLVER',document_strategy='NOTICE_TARGET_RESOLUTION',
  allowed_return_paths=ARRAY['/en/notice/','/de/notice/'],enabled=true,
  validation_status='VALIDATED',last_verified_at=coalesce(last_verified_at,now()),updated_at=now()
WHERE canonical_domain='ted.europa.eu' AND adapter_id='ted-source' AND adapter_version='1.0.0';

-- These exact Cosinex endpoints already have maintained registry and productive
-- capability evidence. This adds only the missing connector contract.
INSERT INTO tender.portal_connector_adapters(
  adapter_id,adapter_version,contract_version,canonical_domain,
  authentication_domains,download_domains,capabilities,login_strategy,
  document_strategy,allowed_return_paths,enabled,validation_status,last_verified_at
)
VALUES(
  'cosinex-vmp-public','1.0.0','2.0.0','vergabemarktplatz.brandenburg.de',
  ARRAY['vergabemarktplatz.brandenburg.de'],ARRAY['vergabemarktplatz.brandenburg.de'],
  ARRAY['PUBLIC_DOCUMENT_INDEX','ZIP_DOWNLOAD','ARCHIVE_RECURSION','MONITOR','LOGIN_HTTP_FORM'],
  'PUBLIC_DOCUMENT_ACCESS','PUBLIC_ARCHIVE_DOWNLOAD',ARRAY['/VMPCenter/'],true,'VALIDATED',now()
)
ON CONFLICT(canonical_domain,adapter_version) DO UPDATE SET
  adapter_id=excluded.adapter_id,contract_version=excluded.contract_version,
  authentication_domains=excluded.authentication_domains,download_domains=excluded.download_domains,
  capabilities=excluded.capabilities,login_strategy=excluded.login_strategy,
  document_strategy=excluded.document_strategy,allowed_return_paths=excluded.allowed_return_paths,
  enabled=true,validation_status='VALIDATED',last_verified_at=now(),updated_at=now();

INSERT INTO tender.audit_events(action,metadata)
VALUES('PORTAL_CONNECTOR_CONTRACTS_ALIGNED',jsonb_build_object(
  'release','20260821-portal-regions-completion.20',
  'hosts',jsonb_build_array('ted.europa.eu','vergabemarktplatz.brandenburg.de'),
  'credentialChanged',false,'companyBindingChanged',false,
  'submissionEnabled',false,'externalWrite',false));

COMMIT;
