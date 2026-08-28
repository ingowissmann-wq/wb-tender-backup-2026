BEGIN;

-- Phase 1 for the REAL Green Admin/Business Portal. This migration is
-- intentionally non-enforcing: run the assertion-guarded internal-WB backfill
-- next, then migration 084. The application feature flag must remain false
-- throughout 083/backfill/084.
DO $$ BEGIN
  IF lower(coalesce(current_setting('app.wb_admin_saas_enabled',true),'false')) <> 'false' THEN
    RAISE EXCEPTION 'wb_admin_saas_must_be_disabled';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS saas.admin_storage_inventory(
  store_key text PRIMARY KEY,
  commercial_module text REFERENCES saas.modules(module_key),
  runtime_store text NOT NULL,
  current_scope text NOT NULL CHECK(current_scope IN('TENANT_BOUND','INTERNAL_ONLY','BLOCKED_UNTIL_ADAPTED','SHARED_PUBLIC')),
  enforcement text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO saas.admin_storage_inventory(store_key,commercial_module,runtime_store,current_scope,enforcement,metadata) VALUES
 ('admin.app.resources','crm','PostgreSQL app.resources','TENANT_BOUND','tenant_id + forced RLS after 084','{"resource_modules":{"companies":"crm","contacts":"crm","leads":"crm","opportunities":"crm","pipelines":"crm","activities":"crm","tasks":"flow","reminders":"flow","notes":"flow","appointments":"flow","documents":"docs","calculator_records":"insights"}}'),
 ('admin.files.objects','docs','PostgreSQL files.objects + /data/private','BLOCKED_UNTIL_ADAPTED','metadata RLS; SaaS download/upload remains 503 until tenant-prefixed storage gate is enabled','{"mount":"/data/private"}'),
 ('admin.audit.events','control','PostgreSQL audit.events','TENANT_BOUND','tenant_id + forced RLS after 084','{}'),
 ('admin.integration','connect','PostgreSQL integration.*','BLOCKED_UNTIL_ADAPTED','tenant columns/RLS added, service calls blocked until signed tenant binding exists','{}'),
 ('admin.communication','connect','PostgreSQL communication.*','BLOCKED_UNTIL_ADAPTED','tenant columns/RLS added; inbound bodies and webhook calls remain blocked until tenant binding exists','{}'),
 ('admin.iam','control','PostgreSQL iam.*','INTERNAL_ONLY','SaaS authenticates through MFA-capable IAM but receives membership-derived permissions; global role/user/session enumeration blocked','{}'),
 ('admin.career.sqlite','people','/career-data/wb-cms.sqlite + /career-data/uploads','INTERNAL_ONLY','all SaaS career/recruiting routes blocked; no row-level tenancy possible in current shared SQLite store','{}'),
 ('admin.cms','control','PostgreSQL cms.* + public website content','INTERNAL_ONLY','not a commercial customer module; SaaS CMS routes blocked','{}'),
 ('admin.csm','csm','No runtime implementation found','BLOCKED_UNTIL_ADAPTED','no route may be exposed','{}')
ON CONFLICT(store_key) DO UPDATE SET commercial_module=excluded.commercial_module,runtime_store=excluded.runtime_store,
 current_scope=excluded.current_scope,enforcement=excluded.enforcement,metadata=excluded.metadata,updated_at=now();

CREATE TABLE IF NOT EXISTS saas.admin_backfill_runs(
  run_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES saas.tenants(id),
  source_manifest_sha256 char(64) NOT NULL,
  source_manifest jsonb NOT NULL,
  applied_by text NOT NULL DEFAULT session_user,
  applied_at timestamptz NOT NULL DEFAULT now(),
  rolled_back_at timestamptz
);
CREATE TABLE IF NOT EXISTS saas.admin_backfill_memberships(
  run_id uuid NOT NULL REFERENCES saas.admin_backfill_runs(run_id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES iam.users(id),
  PRIMARY KEY(run_id,user_id)
);

ALTER TABLE app.resources ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES saas.tenants(id);
ALTER TABLE app.resource_files ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES saas.tenants(id);
ALTER TABLE files.objects ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES saas.tenants(id);
ALTER TABLE crm.documents ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES saas.tenants(id);
ALTER TABLE recruiting.application_files ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES saas.tenants(id);
ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES saas.tenants(id);
ALTER TABLE cms.content_revisions ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES saas.tenants(id);
ALTER TABLE cms.publication_events ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES saas.tenants(id);

DO $cross_module_columns$
DECLARE item record;
BEGIN
  FOR item IN SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema IN('integration','communication') AND table_type='BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES saas.tenants(id)',item.table_schema,item.table_name);
  END LOOP;
END $cross_module_columns$;

CREATE UNIQUE INDEX IF NOT EXISTS app_resources_tenant_id_id ON app.resources(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS files_objects_tenant_id_id ON files.objects(tenant_id,id);
CREATE INDEX IF NOT EXISTS app_resources_tenant_type_updated ON app.resources(tenant_id,resource_type,updated_at DESC);
CREATE INDEX IF NOT EXISTS files_objects_tenant_created ON files.objects(tenant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_tenant_time ON audit.events(tenant_id,occurred_at DESC);

CREATE OR REPLACE FUNCTION saas.admin_source_manifest() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE result jsonb; cross_counts jsonb := '{}'::jsonb; item record; table_count bigint;
BEGIN
  FOR item IN SELECT table_schema,table_name FROM information_schema.tables
    WHERE table_schema IN('integration','communication') AND table_type='BASE TABLE' ORDER BY 1,2
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I',item.table_schema,item.table_name) INTO table_count;
    cross_counts := cross_counts||jsonb_build_object(format('%I.%I',item.table_schema,item.table_name),table_count);
  END LOOP;
  result := jsonb_build_object(
    'app.resources',(SELECT count(*) FROM app.resources),
    'app.resource_files',(SELECT count(*) FROM app.resource_files),
    'files.objects',(SELECT count(*) FROM files.objects),
    'crm.documents',(SELECT count(*) FROM crm.documents),
    'recruiting.application_files',(SELECT count(*) FROM recruiting.application_files),
    'audit.events',(SELECT count(*) FROM audit.events),
    'cms.content_revisions',(SELECT count(*) FROM cms.content_revisions),
    'cms.publication_events',(SELECT count(*) FROM cms.publication_events),
    'iam.users',(SELECT count(*) FROM iam.users),
    'cross_module',cross_counts,
    'resource_ids_sha256',encode(digest(coalesce((SELECT string_agg(id::text,',' ORDER BY id) FROM app.resources),''),'sha256'),'hex'),
    'file_ids_sha256',encode(digest(coalesce((SELECT string_agg(id::text,',' ORDER BY id) FROM files.objects),''),'sha256'),'hex')
  );
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION saas.admin_source_manifest() FROM PUBLIC;

-- Newly created, tenant-owned bookkeeping is fail closed immediately.
ALTER TABLE saas.admin_backfill_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.admin_backfill_memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON saas.admin_backfill_memberships;
CREATE POLICY tenant_isolation ON saas.admin_backfill_memberships
  USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));

UPDATE saas.modules SET maturity_status='PARTIAL',metadata=metadata-'business_source_absent'||jsonb_build_object(
 'real_admin_source_found',true,'admin_integration_migration','083/084','saas_exposure','BLOCKED_UNTIL_084')
WHERE module_key IN('crm','flow','docs','control','insights','connect');
UPDATE saas.modules SET metadata=metadata||jsonb_build_object(
 'real_admin_source_found',false,'saas_exposure','BLOCKED_SOURCE_ABSENT')
WHERE module_key='csm';
UPDATE saas.modules SET metadata=metadata||jsonb_build_object(
 'real_admin_source_found',true,'source_scope','SHARED_INTERNAL_SQLITE','saas_exposure','BLOCKED_UNTIL_TENANT_STORE')
WHERE module_key='people';

COMMIT;
