\set ON_ERROR_STOP on
BEGIN;

-- Disposable candidate DB only. Every fixture is rolled back.
INSERT INTO saas.tenants(id,slug,display_name,status,customer_identity_hash) VALUES
 ('10000000-0000-4000-8000-000000000001','licensing-fixture-one','Licensing isolation fixture one','ACTIVE',repeat('1',64)),
 ('10000000-0000-4000-8000-000000000002','licensing-fixture-two','Licensing isolation fixture two','ACTIVE',repeat('2',64));
SELECT set_config('app.tenant_id','10000000-0000-4000-8000-000000000001',true);
INSERT INTO saas.tenant_product_licenses(id,tenant_id,commercial_product_key,source,status,manual_reason) VALUES
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','wb_crm','MANUAL','ACTIVE','Disposable DB rehearsal'),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','wb_tender_scout','MANUAL','CANCELED','Disposable DB rehearsal'),
 ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','wb_docs','MANUAL','TRIAL_ACTIVE','Disposable DB rehearsal');
UPDATE saas.tenant_product_licenses SET trial_started_at=now()-interval '15 days',trial_ends_at=now()-interval '1 day'
WHERE id='20000000-0000-4000-8000-000000000003';
INSERT INTO saas.tenant_module_entitlements(tenant_id,module_key,enabled,source,metadata)
VALUES('10000000-0000-4000-8000-000000000001','control',false,'DIRECT','{"fixture":true}');

SET LOCAL ROLE saas_runtime;
SELECT set_config('app.tenant_id','10000000-0000-4000-8000-000000000001',true);
DO $$
DECLARE visible_licenses integer; effective_modules text[];
BEGIN
  SELECT count(*) INTO visible_licenses FROM saas.tenant_product_licenses;
  IF visible_licenses<>3 THEN RAISE EXCEPTION 'same_tenant_license_visibility_failed:%',visible_licenses; END IF;
  SELECT array_agg(module_key ORDER BY module_key) INTO effective_modules FROM saas.effective_tenant_modules('10000000-0000-4000-8000-000000000001',now());
  IF effective_modules IS DISTINCT FROM ARRAY['crm']::text[] THEN RAISE EXCEPTION 'effective_union_or_revocation_failed:%',effective_modules; END IF;
END $$;

SELECT set_config('app.tenant_id','10000000-0000-4000-8000-000000000002',true);
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM saas.tenant_product_licenses) THEN RAISE EXCEPTION 'cross_tenant_license_leak'; END IF;
END $$;

SELECT set_config('app.tenant_id','',true);
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM saas.tenant_product_licenses) THEN RAISE EXCEPTION 'missing_tenant_context_leak'; END IF;
END $$;

RESET ROLE;
ROLLBACK;
