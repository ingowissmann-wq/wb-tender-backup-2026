\set ON_ERROR_STOP on
BEGIN;
INSERT INTO saas.tenants(id,status) VALUES('a1670000-0000-4000-8000-000000000001','ACTIVE'),('a1670000-0000-4000-8000-000000000002','ACTIVE');
INSERT INTO saas.subscriptions(tenant_id,plan_code,status) VALUES('a1670000-0000-4000-8000-000000000001','ENTERPRISE','ACTIVE'),('a1670000-0000-4000-8000-000000000002','ENTERPRISE','ACTIVE');
INSERT INTO saas.tenant_companies(id,tenant_id,status) VALUES('b1670000-0000-4000-8000-000000000001','a1670000-0000-4000-8000-000000000001','ACTIVE'),('b1670000-0000-4000-8000-000000000002','a1670000-0000-4000-8000-000000000002','ACTIVE');
INSERT INTO tender.portal_registry(id,canonical_domain) VALUES('c1670000-0000-4000-8000-000000000001','synthetic.invalid');
SET LOCAL ROLE wb_tender_api_login;
SELECT set_config('app.tenant_id','a1670000-0000-4000-8000-000000000001',true);
INSERT INTO tenant_portal.credential_vault(id,tenant_id,company_id,portal_id,label,ciphertext,revision,key_version) VALUES('d1670000-0000-4000-8000-000000000001','a1670000-0000-4000-8000-000000000001','b1670000-0000-4000-8000-000000000001','c1670000-0000-4000-8000-000000000001','SYNTHETIC',decode(repeat('ab',32),'hex'),1,'v1');
DO $$ BEGIN
 BEGIN
  INSERT INTO tenant_portal.credential_vault(tenant_id,company_id,portal_id,label,ciphertext,revision,key_version) VALUES('a1670000-0000-4000-8000-000000000001','b1670000-0000-4000-8000-000000000002','c1670000-0000-4000-8000-000000000001','SYNTHETIC',decode(repeat('ab',32),'hex'),1,'v1');
  RAISE EXCEPTION 'foreign_company_accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN
  UPDATE tenant_portal.credential_vault SET company_id='b1670000-0000-4000-8000-000000000002';
  RAISE EXCEPTION 'binding_update_granted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  UPDATE tenant_portal.credential_vault SET label='unversioned';
  RAISE EXCEPTION 'unversioned_update_accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'credential_revision_invalid' THEN RAISE; END IF; END;
END $$;
UPDATE tenant_portal.credential_vault SET revision=2,key_version='v2',ciphertext=decode(repeat('cd',32),'hex');
SELECT set_config('app.tenant_id','a1670000-0000-4000-8000-000000000002',true);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM tenant_portal.credential_vault) THEN RAISE EXCEPTION 'foreign_tenant_visible'; END IF;
 UPDATE tenant_portal.credential_vault SET revision=3;
 IF FOUND THEN RAISE EXCEPTION 'foreign_tenant_modified'; END IF;
 BEGIN
  INSERT INTO tenant_portal.credential_vault(tenant_id,company_id,portal_id,label,ciphertext,revision,key_version) VALUES('a1670000-0000-4000-8000-000000000001','b1670000-0000-4000-8000-000000000001','c1670000-0000-4000-8000-000000000001','SYNTHETIC',decode(repeat('ab',32),'hex'),1,'v1');
  RAISE EXCEPTION 'foreign_tenant_inserted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SELECT set_config('app.tenant_id','',true);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM tenant_portal.credential_vault) THEN RAISE EXCEPTION 'unbound_tenant_visible'; END IF;
END $$;
ROLLBACK;
