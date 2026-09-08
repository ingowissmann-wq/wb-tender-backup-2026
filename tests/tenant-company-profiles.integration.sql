\set ON_ERROR_STOP on
BEGIN;
INSERT INTO saas.tenants(id,status) VALUES('a1680000-0000-4000-8000-000000000001','ACTIVE'),('a1680000-0000-4000-8000-000000000002','ACTIVE');
INSERT INTO saas.subscriptions(tenant_id,plan_code,status) VALUES('a1680000-0000-4000-8000-000000000001','ENTERPRISE','ACTIVE'),('a1680000-0000-4000-8000-000000000002','ENTERPRISE','ACTIVE');
INSERT INTO saas.tenant_companies(id,tenant_id,status) VALUES('b1680000-0000-4000-8000-000000000001','a1680000-0000-4000-8000-000000000001','ACTIVE'),('b1680000-0000-4000-8000-000000000002','a1680000-0000-4000-8000-000000000002','ACTIVE');
INSERT INTO iam.users(id,email) VALUES('c1680000-0000-4000-8000-000000000001','synthetic-profile@wb-test.invalid');
SET LOCAL ROLE wb_tender_api_login;
SELECT set_config('app.tenant_id','a1680000-0000-4000-8000-000000000001',true);
INSERT INTO tenant_portal.company_profile_versions(id,tenant_id,company_id,service_line,version,valid_from,regions,parameters,request_sha256,created_by)
VALUES('d1680000-0000-4000-8000-000000000001','a1680000-0000-4000-8000-000000000001','b1680000-0000-4000-8000-000000000001','cleaning',1,'2026-01-01','{}','{}',repeat('a',64),'c1680000-0000-4000-8000-000000000001');
DO $$ BEGIN
 BEGIN UPDATE tenant_portal.company_profile_versions SET parameters='{"changed":true}'; RAISE EXCEPTION 'historical_profile_modified'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM tenant_portal.company_profile_versions; RAISE EXCEPTION 'historical_profile_deleted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  INSERT INTO tenant_portal.company_profile_versions(id,tenant_id,company_id,service_line,version,valid_from,regions,parameters,request_sha256,created_by)
  VALUES(gen_random_uuid(),'a1680000-0000-4000-8000-000000000001','b1680000-0000-4000-8000-000000000002','cleaning',1,'2026-01-01','{}','{}',repeat('a',64),'c1680000-0000-4000-8000-000000000001');
  RAISE EXCEPTION 'foreign_company_profile_accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
SELECT set_config('app.tenant_id','a1680000-0000-4000-8000-000000000002',true);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM tenant_portal.company_profile_versions) THEN RAISE EXCEPTION 'foreign_profile_visible'; END IF; END $$;
SELECT set_config('app.tenant_id','',true);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM tenant_portal.company_profile_versions) THEN RAISE EXCEPTION 'unbound_profile_visible'; END IF; END $$;
ROLLBACK;
