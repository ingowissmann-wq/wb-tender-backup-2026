-- Candidate/rehearsal rollback only. Application rollback and
-- WB_ADMIN_SAAS_ENABLED=false must happen first. This preserves columns/data;
-- it removes enforcement so the exact pre-candidate image can run.
BEGIN;
DO $rollback$
DECLARE item record; internal_tenant uuid := nullif(current_setting('app.wb_internal_tenant_id',true),'')::uuid; foreign_rows bigint;
BEGIN
  IF lower(coalesce(current_setting('app.wb_admin_saas_enabled',true),'false')) <> 'false' THEN RAISE EXCEPTION 'wb_admin_saas_must_be_disabled'; END IF;
  IF internal_tenant IS NULL THEN RAISE EXCEPTION 'wb_internal_tenant_required'; END IF;
  FOR item IN
    SELECT * FROM (VALUES
      ('app','resources'),('app','resource_files'),('files','objects'),('crm','documents'),
      ('recruiting','application_files'),('audit','events'),('cms','content_revisions'),('cms','publication_events')
    ) AS target(schema_name,table_name)
    UNION ALL SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema IN('integration','communication') AND table_type='BASE TABLE'
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE tenant_id<>$1',item.schema_name,item.table_name) INTO foreign_rows USING internal_tenant;
    IF foreign_rows<>0 THEN RAISE EXCEPTION 'rollback_refused_customer_data %.% count=%',item.schema_name,item.table_name,foreign_rows; END IF;
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I.%I',item.schema_name,item.table_name);
    EXECUTE format('ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY',item.schema_name,item.table_name);
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN tenant_id DROP NOT NULL',item.schema_name,item.table_name);
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN tenant_id DROP DEFAULT',item.schema_name,item.table_name);
  END LOOP;
END $rollback$;
ALTER TABLE app.resource_files DROP CONSTRAINT IF EXISTS resource_files_tenant_resource_fk;
ALTER TABLE app.resource_files DROP CONSTRAINT IF EXISTS resource_files_tenant_file_fk;
ALTER TABLE crm.documents DROP CONSTRAINT IF EXISTS crm_documents_tenant_resource_fk;
ALTER TABLE crm.documents DROP CONSTRAINT IF EXISTS crm_documents_tenant_file_fk;
ALTER TABLE recruiting.application_files DROP CONSTRAINT IF EXISTS recruiting_files_tenant_resource_fk;
ALTER TABLE recruiting.application_files DROP CONSTRAINT IF EXISTS recruiting_files_tenant_file_fk;
DROP INDEX IF EXISTS app.app_resources_tenant_source_external_unique;
DROP INDEX IF EXISTS files.files_objects_tenant_content_unique;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app.resources'::regclass AND conname='resources_source_system_resource_type_external_id_key') THEN
    ALTER TABLE app.resources ADD CONSTRAINT resources_source_system_resource_type_external_id_key UNIQUE(source_system,resource_type,external_id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='files.objects'::regclass AND conname='objects_sha256_size_bytes_protection_class_key') THEN
    ALTER TABLE files.objects ADD CONSTRAINT objects_sha256_size_bytes_protection_class_key UNIQUE(sha256,size_bytes,protection_class);
  END IF;
END $$;
COMMIT;
