-- Green rehearsal/candidate only. Run after 083 and before 084 in one
-- maintenance window with WB_ADMIN_SAAS_ENABLED=false. Required settings:
--   app.wb_internal_tenant_id       approved INTERNAL tenant UUID
--   app.wb_admin_backfill_run_id    unique run UUID
--   app.wb_admin_source_manifest_sha256 exact digest emitted by the rehearsal
BEGIN;

DO $backfill$
DECLARE
  internal_tenant uuid := nullif(current_setting('app.wb_internal_tenant_id',true),'')::uuid;
  run uuid := nullif(current_setting('app.wb_admin_backfill_run_id',true),'')::uuid;
  expected char(64) := nullif(current_setting('app.wb_admin_source_manifest_sha256',true),'');
  manifest jsonb;
  actual char(64);
  item record;
BEGIN
  IF lower(coalesce(current_setting('app.wb_admin_saas_enabled',true),'false')) <> 'false' THEN
    RAISE EXCEPTION 'wb_admin_saas_must_be_disabled';
  END IF;
  IF internal_tenant IS NULL OR run IS NULL OR expected IS NULL THEN RAISE EXCEPTION 'admin_backfill_inputs_required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM saas.tenants WHERE id=internal_tenant AND tenant_kind='INTERNAL') THEN
    RAISE EXCEPTION 'approved_internal_tenant_required';
  END IF;
  IF EXISTS(SELECT 1 FROM saas.admin_backfill_runs WHERE run_id=run) THEN RAISE EXCEPTION 'admin_backfill_run_reused'; END IF;
  IF EXISTS(SELECT 1 FROM app.resources WHERE tenant_id IS NOT NULL AND tenant_id<>internal_tenant)
     OR EXISTS(SELECT 1 FROM files.objects WHERE tenant_id IS NOT NULL AND tenant_id<>internal_tenant)
     OR EXISTS(SELECT 1 FROM audit.events WHERE tenant_id IS NOT NULL AND tenant_id<>internal_tenant) THEN
    RAISE EXCEPTION 'non_internal_admin_tenant_data_exists';
  END IF;

  manifest := saas.admin_source_manifest();
  actual := encode(digest(manifest::text,'sha256'),'hex');
  IF actual<>expected THEN RAISE EXCEPTION 'admin_source_manifest_mismatch expected=% actual=% manifest=%',expected,actual,manifest; END IF;

  PERFORM set_config('app.tenant_id',internal_tenant::text,true);
  INSERT INTO saas.admin_backfill_runs(run_id,tenant_id,source_manifest_sha256,source_manifest)
    VALUES(run,internal_tenant,actual,manifest);
  UPDATE app.resources SET tenant_id=internal_tenant WHERE tenant_id IS NULL;
  UPDATE files.objects SET tenant_id=internal_tenant WHERE tenant_id IS NULL;
  UPDATE app.resource_files rf SET tenant_id=r.tenant_id FROM app.resources r WHERE r.id=rf.resource_id AND rf.tenant_id IS NULL;
  UPDATE crm.documents d SET tenant_id=r.tenant_id FROM app.resources r WHERE r.id=d.resource_id AND d.tenant_id IS NULL;
  UPDATE recruiting.application_files f SET tenant_id=r.tenant_id FROM app.resources r WHERE r.id=f.application_id AND f.tenant_id IS NULL;
  UPDATE cms.content_revisions c SET tenant_id=r.tenant_id FROM app.resources r WHERE r.id=c.resource_id AND c.tenant_id IS NULL;
  UPDATE cms.publication_events c SET tenant_id=r.tenant_id FROM app.resources r WHERE r.id=c.resource_id AND c.tenant_id IS NULL;
  ALTER TABLE audit.events DISABLE TRIGGER audit_append_only;
  UPDATE audit.events SET tenant_id=internal_tenant WHERE tenant_id IS NULL;
  ALTER TABLE audit.events ENABLE TRIGGER audit_append_only;
  FOR item IN SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema IN('integration','communication') AND table_type='BASE TABLE'
  LOOP EXECUTE format('UPDATE %I.%I SET tenant_id=$1 WHERE tenant_id IS NULL',item.table_schema,item.table_name) USING internal_tenant; END LOOP;

  WITH inserted AS (
    INSERT INTO saas.tenant_memberships(tenant_id,user_id,role,status)
      SELECT internal_tenant,id,'MEMBER','ACTIVE' FROM iam.users
      ON CONFLICT(tenant_id,user_id) DO NOTHING RETURNING tenant_id,user_id
  )
  INSERT INTO saas.admin_backfill_memberships(run_id,tenant_id,user_id) SELECT run,tenant_id,user_id FROM inserted;
END $backfill$;

COMMIT;
