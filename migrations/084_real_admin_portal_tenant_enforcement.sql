BEGIN;

DO $guard$
DECLARE item record; missing bigint;
BEGIN
  IF lower(coalesce(current_setting('app.wb_admin_saas_enabled',true),'false')) <> 'false' THEN RAISE EXCEPTION 'wb_admin_saas_must_be_disabled'; END IF;
  IF NOT EXISTS(SELECT 1 FROM saas.admin_backfill_runs WHERE rolled_back_at IS NULL) THEN RAISE EXCEPTION 'admin_backfill_required'; END IF;
  FOR item IN SELECT * FROM (VALUES
    ('app','resources'),('app','resource_files'),('files','objects'),('crm','documents'),
    ('recruiting','application_files'),('audit','events'),('cms','content_revisions'),('cms','publication_events')
  ) AS target(schema_name,table_name)
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE tenant_id IS NULL',item.schema_name,item.table_name) INTO missing;
    IF missing<>0 THEN RAISE EXCEPTION 'tenant_backfill_incomplete %.% missing=%',item.schema_name,item.table_name,missing; END IF;
  END LOOP;
  FOR item IN SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema IN('integration','communication') AND table_type='BASE TABLE'
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE tenant_id IS NULL',item.table_schema,item.table_name) INTO missing;
    IF missing<>0 THEN RAISE EXCEPTION 'tenant_backfill_incomplete %.% missing=%',item.table_schema,item.table_name,missing; END IF;
  END LOOP;
END $guard$;

ALTER TABLE app.resources ALTER COLUMN tenant_id SET DEFAULT saas.current_tenant_id();
ALTER TABLE app.resource_files ALTER COLUMN tenant_id SET DEFAULT saas.current_tenant_id();
ALTER TABLE files.objects ALTER COLUMN tenant_id SET DEFAULT saas.current_tenant_id();
ALTER TABLE crm.documents ALTER COLUMN tenant_id SET DEFAULT saas.current_tenant_id();
ALTER TABLE recruiting.application_files ALTER COLUMN tenant_id SET DEFAULT saas.current_tenant_id();
ALTER TABLE audit.events ALTER COLUMN tenant_id SET DEFAULT saas.current_tenant_id();
ALTER TABLE cms.content_revisions ALTER COLUMN tenant_id SET DEFAULT saas.current_tenant_id();
ALTER TABLE cms.publication_events ALTER COLUMN tenant_id SET DEFAULT saas.current_tenant_id();
ALTER TABLE app.resources ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE app.resource_files ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE files.objects ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE crm.documents ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE recruiting.application_files ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE audit.events ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE cms.content_revisions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE cms.publication_events ALTER COLUMN tenant_id SET NOT NULL;

DO $constraints$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='resource_files_tenant_resource_fk') THEN
    ALTER TABLE app.resource_files ADD CONSTRAINT resource_files_tenant_resource_fk FOREIGN KEY(tenant_id,resource_id) REFERENCES app.resources(tenant_id,id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='resource_files_tenant_file_fk') THEN
    ALTER TABLE app.resource_files ADD CONSTRAINT resource_files_tenant_file_fk FOREIGN KEY(tenant_id,file_id) REFERENCES files.objects(tenant_id,id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='crm_documents_tenant_resource_fk') THEN
    ALTER TABLE crm.documents ADD CONSTRAINT crm_documents_tenant_resource_fk FOREIGN KEY(tenant_id,resource_id) REFERENCES app.resources(tenant_id,id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='crm_documents_tenant_file_fk') THEN
    ALTER TABLE crm.documents ADD CONSTRAINT crm_documents_tenant_file_fk FOREIGN KEY(tenant_id,file_id) REFERENCES files.objects(tenant_id,id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='recruiting_files_tenant_resource_fk') THEN
    ALTER TABLE recruiting.application_files ADD CONSTRAINT recruiting_files_tenant_resource_fk FOREIGN KEY(tenant_id,application_id) REFERENCES app.resources(tenant_id,id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='recruiting_files_tenant_file_fk') THEN
    ALTER TABLE recruiting.application_files ADD CONSTRAINT recruiting_files_tenant_file_fk FOREIGN KEY(tenant_id,file_id) REFERENCES files.objects(tenant_id,id);
  END IF;
END $constraints$;

ALTER TABLE app.resources DROP CONSTRAINT IF EXISTS resources_source_system_resource_type_external_id_key;
ALTER TABLE app.resources DROP CONSTRAINT IF EXISTS app_resources_source_system_resource_type_external_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS app_resources_tenant_source_external_unique
  ON app.resources(tenant_id,source_system,resource_type,external_id) WHERE external_id IS NOT NULL;
ALTER TABLE files.objects DROP CONSTRAINT IF EXISTS objects_sha256_size_bytes_protection_class_key;
ALTER TABLE files.objects DROP CONSTRAINT IF EXISTS files_objects_sha256_size_bytes_protection_class_key;
CREATE UNIQUE INDEX IF NOT EXISTS files_objects_tenant_content_unique
  ON files.objects(tenant_id,sha256,size_bytes,protection_class) WHERE deleted_at IS NULL;

DO $rls$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('app','resources'),('app','resource_files'),('files','objects'),('crm','documents'),
      ('recruiting','application_files'),('audit','events'),('cms','content_revisions'),('cms','publication_events')
    ) AS target(schema_name,table_name)
    UNION ALL SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema IN('integration','communication') AND table_type='BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN tenant_id SET DEFAULT saas.current_tenant_id()',item.schema_name,item.table_name);
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN tenant_id SET NOT NULL',item.schema_name,item.table_name);
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',item.schema_name,item.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',item.schema_name,item.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I.%I',item.schema_name,item.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I.%I USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id))',item.schema_name,item.table_name);
  END LOOP;
END $rls$;

UPDATE saas.admin_storage_inventory SET current_scope='TENANT_BOUND',updated_at=now()
WHERE store_key IN('admin.app.resources','admin.audit.events');
UPDATE saas.modules SET metadata=metadata||'{"admin_integration_migration":"083/084","saas_exposure":"TENANT_GUARDED"}'::jsonb
WHERE module_key IN('crm','flow','control','insights');

COMMIT;
