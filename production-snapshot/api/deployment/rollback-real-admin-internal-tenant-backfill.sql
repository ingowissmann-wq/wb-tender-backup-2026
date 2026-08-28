-- Run only after the candidate image is rolled back, SaaS is disabled, and
-- rollback-real-admin-tenant-enforcement.sql has succeeded. Required exact
-- settings: app.wb_internal_tenant_id and app.wb_admin_backfill_run_id.
BEGIN;
DO $rollback$
DECLARE
  internal_tenant uuid := nullif(current_setting('app.wb_internal_tenant_id',true),'')::uuid;
  run uuid := nullif(current_setting('app.wb_admin_backfill_run_id',true),'')::uuid;
  item record; foreign_rows bigint;
BEGIN
  IF lower(coalesce(current_setting('app.wb_admin_saas_enabled',true),'false')) <> 'false' THEN RAISE EXCEPTION 'wb_admin_saas_must_be_disabled'; END IF;
  IF EXISTS(SELECT 1 FROM saas.admin_backfill_runs WHERE run_id=run AND tenant_id=internal_tenant AND rolled_back_at IS NOT NULL) THEN RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM saas.admin_backfill_runs WHERE run_id=run AND tenant_id=internal_tenant AND rolled_back_at IS NULL) THEN RAISE EXCEPTION 'admin_backfill_rollback_scope_mismatch'; END IF;
  FOR item IN
    SELECT * FROM (VALUES
      ('app','resources'),('app','resource_files'),('files','objects'),('crm','documents'),
      ('recruiting','application_files'),('audit','events'),('cms','content_revisions'),('cms','publication_events')
    ) AS target(schema_name,table_name)
    UNION ALL SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema IN('integration','communication') AND table_type='BASE TABLE'
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE tenant_id<>$1',item.schema_name,item.table_name) INTO foreign_rows USING internal_tenant;
    IF foreign_rows<>0 THEN RAISE EXCEPTION 'admin_backfill_rollback_refused_customer_data %.% count=%',item.schema_name,item.table_name,foreign_rows; END IF;
  END LOOP;
  DELETE FROM saas.tenant_memberships m USING saas.admin_backfill_memberships b
    WHERE b.run_id=run AND m.tenant_id=b.tenant_id AND m.user_id=b.user_id;
  UPDATE app.resource_files SET tenant_id=NULL WHERE tenant_id=internal_tenant;
  UPDATE crm.documents SET tenant_id=NULL WHERE tenant_id=internal_tenant;
  UPDATE recruiting.application_files SET tenant_id=NULL WHERE tenant_id=internal_tenant;
  UPDATE cms.content_revisions SET tenant_id=NULL WHERE tenant_id=internal_tenant;
  UPDATE cms.publication_events SET tenant_id=NULL WHERE tenant_id=internal_tenant;
  UPDATE app.resources SET tenant_id=NULL WHERE tenant_id=internal_tenant;
  UPDATE files.objects SET tenant_id=NULL WHERE tenant_id=internal_tenant;
  ALTER TABLE audit.events DISABLE TRIGGER audit_append_only;
  UPDATE audit.events SET tenant_id=NULL WHERE tenant_id=internal_tenant;
  ALTER TABLE audit.events ENABLE TRIGGER audit_append_only;
  FOR item IN SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema IN('integration','communication') AND table_type='BASE TABLE'
  LOOP EXECUTE format('UPDATE %I.%I SET tenant_id=NULL WHERE tenant_id=$1',item.table_schema,item.table_name) USING internal_tenant; END LOOP;
  UPDATE saas.admin_backfill_runs SET rolled_back_at=now() WHERE run_id=run;
END $rollback$;
DELETE FROM saas.admin_backfill_memberships WHERE run_id=current_setting('app.wb_admin_backfill_run_id')::uuid;
DELETE FROM saas.admin_backfill_runs WHERE run_id=current_setting('app.wb_admin_backfill_run_id')::uuid
  AND tenant_id=current_setting('app.wb_internal_tenant_id')::uuid AND rolled_back_at IS NOT NULL;
COMMIT;
