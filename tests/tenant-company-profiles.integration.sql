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
RESET ROLE;
GRANT USAGE ON SCHEMA tender TO tender_api_runtime;
GRANT SELECT ON tender.tender_versions,tenant_portal.tender_workspaces TO tender_api_runtime;
INSERT INTO tenant_portal.tender_workspaces(id,tenant_id,public_tender_id) VALUES('e1690000-0000-4000-8000-000000000001','a1680000-0000-4000-8000-000000000001','f1690000-0000-4000-8000-000000000001');
INSERT INTO tender.tender_versions(id,tender_id) VALUES('f1690000-0000-4000-8000-000000000002','f1690000-0000-4000-8000-000000000001'),('f1690000-0000-4000-8000-000000000003','f1690000-0000-4000-8000-000000000004');
SET LOCAL ROLE wb_tender_api_login;
INSERT INTO tenant_portal.lot_assignment_versions(tenant_id,workspace_id,source_version_id,lot_key,version,assignment_kind,company_id,profile_id,snapshot_sha256,details,created_by)
 VALUES('a1680000-0000-4000-8000-000000000001','e1690000-0000-4000-8000-000000000001','f1690000-0000-4000-8000-000000000002','LOT1',1,'AUTOMATIC','b1680000-0000-4000-8000-000000000001','d1680000-0000-4000-8000-000000000001',repeat('b',64),'{}','c1680000-0000-4000-8000-000000000001');
RESET ROLE;
INSERT INTO tenant_portal.files(id,tenant_id) VALUES('a1700000-0000-4000-8000-000000000001','a1680000-0000-4000-8000-000000000001'),('a1700000-0000-4000-8000-000000000002','a1680000-0000-4000-8000-000000000002');
GRANT SELECT,DELETE ON tenant_portal.files TO tender_api_runtime;
SET LOCAL ROLE wb_tender_api_login;
INSERT INTO tenant_portal.lot_calculation_versions(id,tenant_id,assignment_id,version,request_sha256,status,bindings,facts,provenance,result,created_by)
 SELECT 'b1700000-0000-4000-8000-000000000001',tenant_id,id,1,repeat('d',64),'CALCULATED','[]','{}','{}','{}','c1680000-0000-4000-8000-000000000001' FROM tenant_portal.lot_assignment_versions;
INSERT INTO tenant_portal.lot_calculation_files(tenant_id,calculation_id,file_id) VALUES('a1680000-0000-4000-8000-000000000001','b1700000-0000-4000-8000-000000000001','a1700000-0000-4000-8000-000000000001');
DO $$ BEGIN
 BEGIN UPDATE tenant_portal.lot_calculation_versions SET result='{"changed":true}'; RAISE EXCEPTION 'historical_calculation_modified'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM tenant_portal.files WHERE id='a1700000-0000-4000-8000-000000000001'; RAISE EXCEPTION 'calculation_source_deleted'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN INSERT INTO tenant_portal.lot_calculation_files(tenant_id,calculation_id,file_id) VALUES('a1680000-0000-4000-8000-000000000001','b1700000-0000-4000-8000-000000000001','a1700000-0000-4000-8000-000000000002'); RAISE EXCEPTION 'foreign_calculation_file_accepted'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
DO $$ BEGIN
 BEGIN UPDATE tenant_portal.lot_assignment_versions SET version=2; RAISE EXCEPTION 'historical_assignment_modified'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
 INSERT INTO tenant_portal.lot_assignment_versions(tenant_id,workspace_id,source_version_id,lot_key,version,assignment_kind,snapshot_sha256,details,created_by)
 VALUES('a1680000-0000-4000-8000-000000000001','e1690000-0000-4000-8000-000000000001','f1690000-0000-4000-8000-000000000003','LOT2',1,'REVIEW_REQUIRED',repeat('c',64),'{}','c1680000-0000-4000-8000-000000000001');
 RAISE EXCEPTION 'foreign_tender_source_accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'assignment_source_binding_invalid' THEN RAISE; END IF; END;
END $$;
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
DO $$ BEGIN IF EXISTS(SELECT 1 FROM tenant_portal.company_profile_versions) OR EXISTS(SELECT 1 FROM tenant_portal.lot_assignment_versions) OR EXISTS(SELECT 1 FROM tenant_portal.lot_calculation_versions) OR EXISTS(SELECT 1 FROM tenant_portal.lot_calculation_files) THEN RAISE EXCEPTION 'foreign_profile_visible'; END IF; END $$;
SELECT set_config('app.tenant_id','',true);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM tenant_portal.company_profile_versions) THEN RAISE EXCEPTION 'unbound_profile_visible'; END IF; END $$;
ROLLBACK;
