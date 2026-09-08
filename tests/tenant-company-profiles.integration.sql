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
INSERT INTO tenant_portal.management_decisions(id,tenant_id,calculation_id,decision,reason,request_sha256,approved_payload_sha256,manifest,created_by)
 VALUES('c1710000-0000-4000-8000-000000000001','a1680000-0000-4000-8000-000000000001','b1700000-0000-4000-8000-000000000001','APPROVED','SYNTHETIC management review',repeat('e',64),repeat('f',64),'{}','c1680000-0000-4000-8000-000000000001');
INSERT INTO tenant_portal.lot_document_reviews(id,tenant_id,assignment_id,version,status,source_manifest,requirements,request_sha256,snapshot_sha256,created_by)
 SELECT 'd1720000-0000-4000-8000-000000000001',tenant_id,id,1,'REVIEW_REQUIRED','[]','[]',repeat('a',64),repeat('b',64),'c1680000-0000-4000-8000-000000000001' FROM tenant_portal.lot_assignment_versions;
INSERT INTO tenant_portal.lot_document_review_files(tenant_id,review_id,file_id,purpose) VALUES('a1680000-0000-4000-8000-000000000001','d1720000-0000-4000-8000-000000000001','a1700000-0000-4000-8000-000000000001','PROCUREMENT_SOURCE');
DO $$ BEGIN
 BEGIN UPDATE tenant_portal.lot_document_reviews SET requirements='[{}]'; RAISE EXCEPTION 'document_history_modified'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO tenant_portal.lot_document_review_files(tenant_id,review_id,file_id,purpose) VALUES('a1680000-0000-4000-8000-000000000001','d1720000-0000-4000-8000-000000000001','a1700000-0000-4000-8000-000000000002','BID_EVIDENCE'); RAISE EXCEPTION 'foreign_review_file_accepted'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
INSERT INTO tenant_portal.offer_packages(id,tenant_id,calculation_id,document_review_id,version,manifest,manifest_sha256,request_sha256,created_by)
 VALUES('e1730000-0000-4000-8000-000000000001','a1680000-0000-4000-8000-000000000001','b1700000-0000-4000-8000-000000000001','d1720000-0000-4000-8000-000000000001',1,'{}',repeat('a',64),repeat('b',64),'c1680000-0000-4000-8000-000000000001');
INSERT INTO tenant_portal.offer_package_files(tenant_id,package_id,file_id) VALUES('a1680000-0000-4000-8000-000000000001','e1730000-0000-4000-8000-000000000001','a1700000-0000-4000-8000-000000000001');
INSERT INTO tenant_portal.offer_package_decisions(id,tenant_id,package_id,decision,reason,manifest_sha256,request_sha256,created_by)
 VALUES('f1730000-0000-4000-8000-000000000001','a1680000-0000-4000-8000-000000000001','e1730000-0000-4000-8000-000000000001','APPROVED','SYNTHETIC package approval',repeat('a',64),repeat('b',64),'c1680000-0000-4000-8000-000000000001');
DO $$ BEGIN
 BEGIN UPDATE tenant_portal.offer_package_decisions SET decision='REJECTED'; RAISE EXCEPTION 'package_approval_modified'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM tenant_portal.offer_packages; RAISE EXCEPTION 'package_history_deleted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO tenant_portal.offer_package_files(tenant_id,package_id,file_id) VALUES('a1680000-0000-4000-8000-000000000001','e1730000-0000-4000-8000-000000000001','a1700000-0000-4000-8000-000000000002'); RAISE EXCEPTION 'foreign_package_file_accepted'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
DO $$ BEGIN BEGIN UPDATE tenant_portal.management_decisions SET decision='REJECTED'; RAISE EXCEPTION 'management_history_modified'; EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $$;
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
INSERT INTO tenant_portal.workflow_task_versions(id,tenant_id,task_id,version,company_id,title,description,status,deadline_source,checklist,reason,request_sha256,created_by)
VALUES('a1750000-0000-4000-8000-000000000001','a1680000-0000-4000-8000-000000000001','b1750000-0000-4000-8000-000000000001',1,'b1680000-0000-4000-8000-000000000001','SYNTHETIC task','','OPEN','','[{"id":"c1750000-0000-4000-8000-000000000001","label":"Verify own source","done":false}]','SYNTHETIC reviewed source',repeat('a',64),'c1680000-0000-4000-8000-000000000001');
DO $$ BEGIN
 BEGIN UPDATE tenant_portal.workflow_task_versions SET status='DONE'; RAISE EXCEPTION 'historical_task_modified'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM tenant_portal.workflow_task_versions; RAISE EXCEPTION 'historical_task_deleted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
 INSERT INTO tenant_portal.workflow_task_versions(id,tenant_id,task_id,version,company_id,title,description,status,deadline_source,checklist,reason,request_sha256,created_by)
 SELECT gen_random_uuid(),tenant_id,gen_random_uuid(),1,'b1680000-0000-4000-8000-000000000002',title,description,status,deadline_source,checklist,reason,request_sha256,created_by FROM tenant_portal.workflow_task_versions;
 RAISE EXCEPTION 'foreign_task_company_accepted'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
SELECT set_config('app.tenant_id','a1680000-0000-4000-8000-000000000002',true);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM tenant_portal.workflow_task_versions) OR EXISTS(SELECT 1 FROM tenant_portal.company_profile_versions) OR EXISTS(SELECT 1 FROM tenant_portal.lot_assignment_versions) OR EXISTS(SELECT 1 FROM tenant_portal.lot_calculation_versions) OR EXISTS(SELECT 1 FROM tenant_portal.lot_calculation_files) OR EXISTS(SELECT 1 FROM tenant_portal.management_decisions) OR EXISTS(SELECT 1 FROM tenant_portal.lot_document_reviews) OR EXISTS(SELECT 1 FROM tenant_portal.lot_document_review_files) OR EXISTS(SELECT 1 FROM tenant_portal.offer_packages) OR EXISTS(SELECT 1 FROM tenant_portal.offer_package_files) OR EXISTS(SELECT 1 FROM tenant_portal.offer_package_decisions) THEN RAISE EXCEPTION 'foreign_profile_visible'; END IF; END $$;
SELECT set_config('app.tenant_id','',true);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM tenant_portal.company_profile_versions) THEN RAISE EXCEPTION 'unbound_profile_visible'; END IF; END $$;
ROLLBACK;
