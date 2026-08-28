\set ON_ERROR_STOP on

INSERT INTO saas.tenants(id,slug,display_name,status,customer_identity_hash,tenant_kind)
VALUES('00000000-0000-4000-8000-000000001250','context-125','Context 125','ACTIVE',repeat('1',64),'INTERNAL')
ON CONFLICT(id) DO NOTHING;

INSERT INTO cms.business_units(id,code,name,status)
VALUES('00000000-0000-4000-8000-000000001252','context-125','Context 125 GmbH','approved')
ON CONFLICT(id) DO NOTHING;

INSERT INTO tender.company_profiles(id,company_id,version,name,lifecycle_status,profile_sha256)
VALUES('00000000-0000-4000-8000-000000001251','00000000-0000-4000-8000-000000001252',1,
  'Context 125 Company','DRAFT',repeat('2',64))
ON CONFLICT(id) DO NOTHING;

INSERT INTO tender.enterprise_company_links(company_id,tender_profile_id,legal_name,display_name,
  technical_key,slug,active,sector_slug,sector_status,discovery_status,matching_status,
  calculation_status,creation_source,configuration_version,applied_transaction_id)
VALUES('00000000-0000-4000-8000-000000001252','00000000-0000-4000-8000-000000001251',
  'Context 125 GmbH','Context 125','context-125','context-125',true,'cleaning','approved',
  'ACTIVE','PARTIAL','BLOCKED','ISOLATED_STAGING',2,'00000000-0000-4000-8000-000000001253');

INSERT INTO saas.legacy_company_tenant_bindings(company_id,tenant_id,backfill_run_id)
VALUES('00000000-0000-4000-8000-000000001252','00000000-0000-4000-8000-000000001250',
  '00000000-0000-4000-8000-000000001254');

INSERT INTO tender.tender_versions(id,tender_id,version,source_sha256,normalized_data,change_kind)
VALUES('00000000-0000-4000-8000-000000001255','00000000-0000-4000-8000-000000001231',1,
  repeat('3',64),'{}','INITIAL');

INSERT INTO tender.enrichment_context_bindings(enrichment_version_id,tenant_id,company_id,tender_id,
  tender_version_id,lot_id,source_lot_id,canonical_service,source_manifest_sha256)
SELECT '00000000-0000-4000-8000-000000001240','00000000-0000-4000-8000-000000001250',
  '00000000-0000-4000-8000-000000001252','00000000-0000-4000-8000-000000001231',
  '00000000-0000-4000-8000-000000001255',lot.id,'LOT-STAGING-1','cleaning',repeat('4',64)
FROM tender.lots lot
WHERE lot.tender_id='00000000-0000-4000-8000-000000001231' AND lot.external_id='LOT-STAGING-1';

INSERT INTO tender.pipeline_contexts(id,tender_id,lot_key,company_id,pipeline_version,current_step)
VALUES
('00000000-0000-4000-8000-000000001256','00000000-0000-4000-8000-000000001231','LOT-STAGING-1','00000000-0000-4000-8000-000000001252','context/125-canonical','SOURCE_RESOLVED'),
('00000000-0000-4000-8000-000000001257','00000000-0000-4000-8000-000000001231','','00000000-0000-4000-8000-000000001252','context/125-global','SOURCE_RESOLVED'),
('00000000-0000-4000-8000-000000001258','00000000-0000-4000-8000-000000001231','LOT-NOT-CANONICAL','00000000-0000-4000-8000-000000001252','context/125-repair','SOURCE_RESOLVED');
