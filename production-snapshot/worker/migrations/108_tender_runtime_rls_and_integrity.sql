BEGIN;

DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tender_api_runtime') THEN CREATE ROLE tender_api_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tender_worker_runtime') THEN CREATE ROLE tender_worker_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tender_scheduler_runtime') THEN CREATE ROLE tender_scheduler_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='saas_runtime') THEN CREATE ROLE saas_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wb_admin_runtime') THEN CREATE ROLE wb_admin_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF;
END $$;

CREATE OR REPLACE FUNCTION tender.runtime_uuid_list(setting_name text) RETURNS uuid[]
LANGUAGE plpgsql STABLE AS $$
DECLARE raw text;
BEGIN
  raw:=current_setting(setting_name,true);
  IF raw IS NULL OR raw='' THEN RETURN '{}'::uuid[]; END IF;
  RETURN string_to_array(raw,',')::uuid[];
EXCEPTION WHEN invalid_text_representation THEN RETURN '{}'::uuid[];
END $$;
CREATE OR REPLACE FUNCTION tender.runtime_tenant_allowed(candidate uuid) RETURNS boolean
LANGUAGE sql STABLE LEAKPROOF AS $$ SELECT candidate IS NOT NULL AND candidate=ANY(tender.runtime_uuid_list('app.tenant_ids')) $$;
CREATE OR REPLACE FUNCTION tender.runtime_company_allowed(candidate uuid) RETURNS boolean
LANGUAGE sql STABLE LEAKPROOF AS $$ SELECT candidate IS NOT NULL AND candidate=ANY(tender.runtime_uuid_list('app.company_ids')) $$;
CREATE OR REPLACE FUNCTION tender.resolve_runtime_tenants(candidate_companies uuid[]) RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,saas AS $$
 SELECT DISTINCT b.tenant_id FROM saas.legacy_company_tenant_bindings b WHERE b.company_id=ANY(candidate_companies) ORDER BY b.tenant_id
$$;
REVOKE ALL ON FUNCTION tender.resolve_runtime_tenants(uuid[]) FROM PUBLIC;

CREATE OR REPLACE FUNCTION tender.resolve_background_scope() RETURNS TABLE(tenant_id uuid,company_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,saas AS $$
 SELECT b.tenant_id,b.company_id FROM saas.legacy_company_tenant_bindings b ORDER BY b.tenant_id,b.company_id
$$;
REVOKE ALL ON FUNCTION tender.resolve_background_scope() FROM PUBLIC;

-- Reuse the already-authoritative Green tenant UUID. No company/business value is invented.
INSERT INTO saas.tenants(id,slug,display_name,status,customer_identity_hash,tenant_kind)
SELECT id,'wb-internal',tenant_key,'ACTIVE',encode(digest(id::text,'sha256'),'hex'),'INTERNAL'
FROM tender.configuration_tenants ON CONFLICT(id) DO NOTHING;
INSERT INTO tenant_portal.organizations(tenant_id,display_name)
SELECT id,tenant_key FROM tender.configuration_tenants ON CONFLICT(tenant_id) DO NOTHING;
INSERT INTO tenant_portal.tenant_settings(tenant_id,demo_data_enabled)
SELECT id,false FROM tender.configuration_tenants ON CONFLICT(tenant_id) DO NOTHING;
DO $$ DECLARE run_id uuid:=gen_random_uuid(); tenant uuid; expected integer; BEGIN
  SELECT id INTO STRICT tenant FROM tender.configuration_tenants;
  SELECT count(*) INTO expected FROM tender.enterprise_company_links;
  INSERT INTO saas.legacy_company_tenant_bindings(company_id,tenant_id,backfill_run_id)
  SELECT company_id,tenant,run_id FROM tender.enterprise_company_links ON CONFLICT(company_id) DO NOTHING;
  INSERT INTO saas.tenant_backfill_runs(id,tenant_id,expected_company_count,actual_company_count,source_fingerprint,executed_by)
  SELECT run_id,tenant,expected,count(*),encode(digest(string_agg(company_id::text,',' ORDER BY company_id),'sha256'),'hex'),session_user
  FROM saas.legacy_company_tenant_bindings WHERE tenant_id=tenant;
  IF (SELECT count(*) FROM saas.legacy_company_tenant_bindings WHERE tenant_id=tenant)<>expected THEN RAISE EXCEPTION 'internal_tenant_company_reconciliation_failed'; END IF;
END $$;

ALTER TABLE tender.portal_credential_companies ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE tender.portal_read_sessions ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE tender.calculations ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE tender.calculation_input_snapshots ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE tender.management_outputs ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE tender.approval_requests ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE tender.approval_requests ADD COLUMN IF NOT EXISTS company_id uuid;
ALTER TABLE tender.bid_packages ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE tender.bid_packages ADD COLUMN IF NOT EXISTS company_id uuid;
ALTER TABLE tender.submission_contexts ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE tender.required_documents ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE tender.required_document_uploads ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE tender.required_document_working_copies ADD COLUMN IF NOT EXISTS tenant_id uuid;

UPDATE tender.portal_credential_companies x SET tenant_id=b.tenant_id FROM saas.legacy_company_tenant_bindings b WHERE b.company_id=x.company_id AND x.tenant_id IS NULL;
UPDATE tender.portal_read_sessions x SET tenant_id=b.tenant_id FROM saas.legacy_company_tenant_bindings b WHERE b.company_id=x.company_id AND x.tenant_id IS NULL;
CREATE TABLE IF NOT EXISTS tender.portal_read_session_quarantine (LIKE tender.portal_read_sessions INCLUDING ALL);
ALTER TABLE tender.portal_read_session_quarantine ADD COLUMN IF NOT EXISTS quarantine_reason text NOT NULL DEFAULT 'LEGACY_SCOPE_UNRECOVERABLE';
ALTER TABLE tender.portal_read_session_quarantine ADD COLUMN IF NOT EXISTS quarantined_at timestamptz NOT NULL DEFAULT now();
INSERT INTO tender.portal_read_session_quarantine SELECT x.*,'LEGACY_SCOPE_UNRECOVERABLE',now() FROM tender.portal_read_sessions x
WHERE x.tenant_id IS NULL OR x.company_id IS NULL ON CONFLICT(id) DO NOTHING;
DO $$ DECLARE source_count bigint; copied_count bigint; BEGIN
 SELECT count(*) INTO source_count FROM tender.portal_read_sessions WHERE tenant_id IS NULL OR company_id IS NULL;
 SELECT count(*) INTO copied_count FROM tender.portal_read_session_quarantine q WHERE EXISTS(SELECT 1 FROM tender.portal_read_sessions s WHERE s.id=q.id AND (s.tenant_id IS NULL OR s.company_id IS NULL));
 IF source_count<>copied_count THEN RAISE EXCEPTION 'portal_session_quarantine_reconciliation_failed'; END IF;
END $$;
UPDATE tender.submission_contexts c SET portal_session_id=NULL,submission_status='WAITING_FOR_SESSION',preflight_status='BLOCKED',portal_validation_status='SESSION_REAUTH_REQUIRED',
 blockers=coalesce(blockers,'[]'::jsonb)||jsonb_build_array(jsonb_build_object('code','LEGACY_SESSION_SCOPE_UNRECOVERABLE','reconciledAt',now()))
WHERE EXISTS(SELECT 1 FROM tender.portal_read_session_quarantine q WHERE q.id=c.portal_session_id);
DELETE FROM tender.portal_read_sessions WHERE tenant_id IS NULL OR company_id IS NULL;
ALTER TABLE tender.portal_read_session_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender.portal_read_session_quarantine FORCE ROW LEVEL SECURITY;
REVOKE ALL ON tender.portal_read_session_quarantine FROM PUBLIC,tender_api_runtime,tender_worker_runtime,tender_scheduler_runtime;
UPDATE tender.calculations x SET tenant_id=b.tenant_id FROM saas.legacy_company_tenant_bindings b WHERE b.company_id=x.company_id AND x.tenant_id IS NULL;
UPDATE tender.calculation_input_snapshots x SET tenant_id=b.tenant_id FROM saas.legacy_company_tenant_bindings b WHERE b.company_id=x.company_id AND x.tenant_id IS NULL;
UPDATE tender.management_outputs x SET tenant_id=b.tenant_id FROM saas.legacy_company_tenant_bindings b WHERE b.company_id=x.company_id AND x.tenant_id IS NULL;
UPDATE tender.approval_requests x SET company_id=c.company_id,tenant_id=c.tenant_id FROM tender.calculations c WHERE c.id=x.calculation_id AND (x.company_id IS NULL OR x.tenant_id IS NULL);
UPDATE tender.bid_packages x SET company_id=c.company_id,tenant_id=c.tenant_id FROM tender.calculations c WHERE c.id=x.calculation_id AND (x.company_id IS NULL OR x.tenant_id IS NULL);
UPDATE tender.submission_contexts x SET tenant_id=b.tenant_id FROM saas.legacy_company_tenant_bindings b WHERE b.company_id=x.company_id AND x.tenant_id IS NULL;
UPDATE tender.required_documents x SET tenant_id=b.tenant_id FROM saas.legacy_company_tenant_bindings b WHERE b.company_id=x.company_id AND x.tenant_id IS NULL;
UPDATE tender.required_document_uploads x SET tenant_id=b.tenant_id FROM saas.legacy_company_tenant_bindings b WHERE b.company_id=x.company_id AND x.tenant_id IS NULL;
UPDATE tender.required_document_working_copies x SET tenant_id=b.tenant_id FROM saas.legacy_company_tenant_bindings b WHERE b.company_id=x.company_id AND x.tenant_id IS NULL;
UPDATE tender.management_inbox x SET tenant_id=b.tenant_id FROM saas.legacy_company_tenant_bindings b WHERE b.company_id=x.company_id AND x.tenant_id IS NULL;

DO $$ DECLARE item_name text; BEGIN
  FOREACH item_name IN ARRAY ARRAY['portal_credential_companies','portal_read_sessions','calculations','calculation_input_snapshots','management_outputs','approval_requests','bid_packages','submission_contexts','required_documents','required_document_uploads','required_document_working_copies'] LOOP
    IF EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema='tender' AND c.table_name=item_name AND c.column_name='tenant_id' AND c.is_nullable='YES') THEN
      EXECUTE format('ALTER TABLE tender.%I ALTER COLUMN tenant_id SET NOT NULL',item_name);
    END IF;
    EXECUTE format('ALTER TABLE tender.%I ENABLE ROW LEVEL SECURITY',item_name);
    EXECUTE format('ALTER TABLE tender.%I FORCE ROW LEVEL SECURITY',item_name);
    EXECUTE format('DROP POLICY IF EXISTS runtime_scope ON tender.%I',item_name);
    IF EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema='tender' AND c.table_name=item_name AND c.column_name='company_id') THEN
      EXECUTE format('CREATE POLICY runtime_scope ON tender.%I USING(tender.runtime_tenant_allowed(tenant_id) AND tender.runtime_company_allowed(company_id)) WITH CHECK(tender.runtime_tenant_allowed(tenant_id) AND tender.runtime_company_allowed(company_id))',item_name);
    ELSE
      EXECUTE format('CREATE POLICY runtime_scope ON tender.%I USING(tender.runtime_tenant_allowed(tenant_id)) WITH CHECK(tender.runtime_tenant_allowed(tenant_id))',item_name);
    END IF;
  END LOOP;
END $$;

ALTER TABLE tender.management_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender.management_inbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS runtime_scope ON tender.management_inbox;
DROP POLICY IF EXISTS tenant_company_scope ON tender.management_inbox;
DROP POLICY IF EXISTS configuration_tenant_isolation ON tender.management_inbox;
CREATE POLICY runtime_scope ON tender.management_inbox USING(tender.runtime_tenant_allowed(tenant_id) AND tender.runtime_company_allowed(company_id)) WITH CHECK(tender.runtime_tenant_allowed(tenant_id) AND tender.runtime_company_allowed(company_id));

ALTER TABLE tender.service_relevance_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender.service_relevance_evaluations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS runtime_scope ON tender.service_relevance_evaluations;
CREATE POLICY runtime_scope ON tender.service_relevance_evaluations USING(
 tender.runtime_company_allowed(company_id) AND EXISTS(SELECT 1 FROM saas.legacy_company_tenant_bindings b WHERE b.company_id=service_relevance_evaluations.company_id AND tender.runtime_tenant_allowed(b.tenant_id))
) WITH CHECK(
 tender.runtime_company_allowed(company_id) AND EXISTS(SELECT 1 FROM saas.legacy_company_tenant_bindings b WHERE b.company_id=service_relevance_evaluations.company_id AND tender.runtime_tenant_allowed(b.tenant_id))
);

ALTER TABLE tender.portal_credential_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender.portal_credential_secrets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS runtime_scope ON tender.portal_credential_secrets;
CREATE POLICY runtime_scope ON tender.portal_credential_secrets USING(EXISTS(
  SELECT 1 FROM tender.portal_credential_companies scope WHERE scope.credential_id=portal_credential_secrets.id
    AND scope.active AND tender.runtime_tenant_allowed(scope.tenant_id) AND tender.runtime_company_allowed(scope.company_id)
));

ALTER TABLE crm.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS runtime_scope ON crm.documents;
CREATE POLICY runtime_scope ON crm.documents USING(tender.runtime_tenant_allowed(tenant_id)) WITH CHECK(tender.runtime_tenant_allowed(tenant_id));
ALTER TABLE recruiting.application_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE recruiting.application_files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS runtime_scope ON recruiting.application_files;
CREATE POLICY runtime_scope ON recruiting.application_files USING(tender.runtime_tenant_allowed(tenant_id)) WITH CHECK(tender.runtime_tenant_allowed(tenant_id));

-- Enforce the database boundary on every physical Tender table carrying a
-- tenant/company binding, including workflows not named in the original audit.
-- Truly global public/catalog rows are limited to an explicit allow-list.
DO $$ DECLARE item record; predicate text; global_allowed boolean; BEGIN
 FOR item IN
  SELECT c.table_name,
    bool_or(c.column_name='tenant_id') has_tenant,
    bool_or(c.column_name='company_id') has_company
  FROM information_schema.columns c JOIN information_schema.tables t USING(table_schema,table_name)
  WHERE c.table_schema='tender' AND t.table_type='BASE TABLE' AND c.column_name IN('tenant_id','company_id')
  GROUP BY c.table_name
 LOOP
  IF item.table_name='portal_read_session_quarantine' THEN CONTINUE; END IF;
  global_allowed:=item.table_name=ANY(ARRAY['tenders','document_templates','favorites']);
  IF item.has_tenant AND item.has_company THEN
    predicate:='tender.runtime_tenant_allowed(tenant_id) AND tender.runtime_company_allowed(company_id)';
  ELSIF item.has_tenant THEN
    predicate:='tender.runtime_tenant_allowed(tenant_id)';
  ELSE
    predicate:=format('%s(tender.runtime_company_allowed(company_id) AND EXISTS(SELECT 1 FROM saas.legacy_company_tenant_bindings runtime_binding WHERE runtime_binding.company_id=%I.company_id AND tender.runtime_tenant_allowed(runtime_binding.tenant_id)))',CASE WHEN global_allowed THEN 'company_id IS NULL OR ' ELSE '' END,item.table_name);
  END IF;
  EXECUTE format('ALTER TABLE tender.%I ENABLE ROW LEVEL SECURITY',item.table_name);
  EXECUTE format('ALTER TABLE tender.%I FORCE ROW LEVEL SECURITY',item.table_name);
  EXECUTE format('DROP POLICY IF EXISTS runtime_bound_scope ON tender.%I',item.table_name);
  EXECUTE format('CREATE POLICY runtime_bound_scope ON tender.%I USING(%s) WITH CHECK(%s)',item.table_name,predicate,predicate);
 END LOOP;
END $$;

DO $$ BEGIN
 IF to_regclass('saas.admin_backfill_runs') IS NOT NULL THEN
  ALTER TABLE saas.admin_backfill_runs ENABLE ROW LEVEL SECURITY;
  ALTER TABLE saas.admin_backfill_runs FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON saas.admin_backfill_runs;
  CREATE POLICY tenant_isolation ON saas.admin_backfill_runs USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS tender.document_malware_scans(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),document_id uuid NOT NULL REFERENCES tender.enrichment_documents(id) ON DELETE CASCADE,
  payload_sha256 char(64) NOT NULL,engine text,engine_version text,status text NOT NULL DEFAULT 'PENDING',detail_code text,
  attempt integer NOT NULL DEFAULT 0,next_retry_at timestamptz,scanned_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(status IN('PENDING','CLEAN','INFECTED','SCAN_ERROR','QUARANTINED')),UNIQUE(document_id,payload_sha256)
);
INSERT INTO tender.document_malware_scans(document_id,payload_sha256,status)
SELECT id,payload_sha256,'PENDING' FROM tender.enrichment_documents WHERE procurement_relevant AND payload_sha256 IS NOT NULL ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION tender.invalidate_submission_artifacts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_tender uuid; target_company uuid; target_lot text;
BEGIN
  target_tender:=coalesce(NEW.tender_id,OLD.tender_id); target_company:=coalesce(NEW.company_id,OLD.company_id); target_lot:=coalesce(NEW.lot_key,OLD.lot_key,'');
  UPDATE tender.bid_packages SET status='SUPERSEDED',superseded_at=coalesce(superseded_at,now())
   WHERE tender_id=target_tender AND company_id=target_company AND lot_key=target_lot AND status<>'SUPERSEDED';
  UPDATE tender.approval_requests SET status='SUPERSEDED'
   WHERE tender_id=target_tender AND company_id=target_company AND status IN('REQUESTED','APPROVED');
  RETURN coalesce(NEW,OLD);
END $$;
DROP TRIGGER IF EXISTS required_document_invalidates_package ON tender.required_documents;
CREATE TRIGGER required_document_invalidates_package AFTER INSERT OR UPDATE OR DELETE ON tender.required_documents FOR EACH ROW EXECUTE FUNCTION tender.invalidate_submission_artifacts();
DROP TRIGGER IF EXISTS calculation_invalidates_package ON tender.calculations;
CREATE TRIGGER calculation_invalidates_package AFTER UPDATE OR DELETE ON tender.calculations FOR EACH ROW EXECUTE FUNCTION tender.invalidate_submission_artifacts();
DROP TRIGGER IF EXISTS management_output_invalidates_package ON tender.management_outputs;
CREATE TRIGGER management_output_invalidates_package AFTER UPDATE OR DELETE ON tender.management_outputs FOR EACH ROW EXECUTE FUNCTION tender.invalidate_submission_artifacts();

WITH invalid AS(
 SELECT p.id FROM tender.bid_packages p WHERE p.status='BID_PACKAGE_READY_FOR_SUBMISSION' AND EXISTS(
  SELECT 1 FROM tender.required_documents d WHERE d.tender_id=p.tender_id AND d.company_id=p.company_id AND coalesce(d.lot_key,'')=p.lot_key
   AND d.mandatory AND d.submission_relevant AND d.satisfaction_status NOT IN('VALIDATED','NOT_REQUIRED'))
) UPDATE tender.bid_packages p SET status='SUPERSEDED',superseded_at=now(),missing_items=missing_items||jsonb_build_array(jsonb_build_object('code','CURRENT_REQUIRED_DOCUMENTS_UNSATISFIED','reconciledAt',now())) FROM invalid WHERE p.id=invalid.id;
UPDATE tender.approval_requests a SET status='SUPERSEDED' WHERE a.status IN('REQUESTED','APPROVED') AND EXISTS(SELECT 1 FROM tender.bid_packages p WHERE p.tender_id=a.tender_id AND p.calculation_id=a.calculation_id AND p.status='SUPERSEDED');
UPDATE tender.approval_requests a SET status='SUPERSEDED' WHERE a.status IN('REQUESTED','APPROVED') AND NOT EXISTS(
 SELECT 1 FROM tender.bid_packages p WHERE p.tender_id=a.tender_id AND p.calculation_id=a.calculation_id AND p.company_id=a.company_id AND p.status='BID_PACKAGE_READY_FOR_SUBMISSION'
);

UPDATE tender.portal_read_sessions SET status='EXPIRED',verification_status='EXPIRED_MATERIALIZED',revoked_at=coalesce(revoked_at,now())
WHERE status='ACTIVE' AND expires_at<=now();
UPDATE tender.enrichment_documents SET procurement_verification_status='REVIEW_REQUIRED'
WHERE procurement_verification_status='VERIFIED' AND fetch_status IN('DOWNLOAD_FEHLGESCHLAGEN','PARSER_FEHLER');

-- Runtime roles receive DML, never ownership/DDL/BYPASSRLS. Row policies remain authoritative.
GRANT CONNECT ON DATABASE wb_platform TO tender_api_runtime,tender_worker_runtime,tender_scheduler_runtime,saas_runtime;
GRANT USAGE ON SCHEMA tender,iam,saas,tenant_portal,crm,recruiting TO tender_api_runtime,tender_worker_runtime,tender_scheduler_runtime,saas_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA tender TO tender_api_runtime,tender_worker_runtime,tender_scheduler_runtime;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA tender TO tender_api_runtime,tender_worker_runtime,tender_scheduler_runtime;
GRANT SELECT ON iam.sessions,iam.users,iam.user_roles,iam.roles,iam.role_permissions,iam.permissions,iam.tender_identity_scopes TO tender_api_runtime;
GRANT SELECT ON saas.legacy_company_tenant_bindings TO tender_worker_runtime,tender_scheduler_runtime;
GRANT EXECUTE ON FUNCTION tender.resolve_runtime_tenants(uuid[]) TO tender_api_runtime;
GRANT EXECUTE ON FUNCTION tender.resolve_background_scope() TO tender_api_runtime,tender_worker_runtime,tender_scheduler_runtime;
GRANT EXECUTE ON FUNCTION saas.current_tenant_id(),saas.tenant_matches(uuid) TO tender_api_runtime,tender_worker_runtime,tender_scheduler_runtime,saas_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA saas,tenant_portal TO saas_runtime,tender_api_runtime;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA saas,tenant_portal TO saas_runtime,tender_api_runtime;

COMMIT;
