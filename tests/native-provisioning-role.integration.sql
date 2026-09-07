\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
 IF NOT has_function_privilege('wb_tender_api_login','saas.provision_pending_native_identity(uuid)','EXECUTE') THEN RAISE EXCEPTION 'native_provisioning_runtime_permission_missing'; END IF;
END $$;
SET LOCAL ROLE wb_tender_api_login;
SELECT set_config('app.tenant_id','',true);
DO $$ BEGIN
 BEGIN
  PERFORM saas.provision_pending_native_identity(gen_random_uuid());
  RAISE EXCEPTION 'native_provisioning_without_tenant_accepted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'tenant_context_required' THEN RAISE; END IF;
 END;
END $$;
ROLLBACK;
