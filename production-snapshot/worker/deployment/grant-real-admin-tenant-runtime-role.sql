-- Run as migration owner after 083/084. Required setting:
--   app.admin_runtime_role = exact existing Admin web runtime role
DO $grant_runtime$
DECLARE runtime_role text := nullif(current_setting('app.admin_runtime_role',true),'');
BEGIN
  IF runtime_role IS NULL OR runtime_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN RAISE EXCEPTION 'valid_admin_runtime_role_required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=runtime_role AND NOT rolsuper) THEN RAISE EXCEPTION 'non_superuser_admin_runtime_role_required'; END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA saas,app,files,crm,recruiting,audit,cms,integration TO %I',runtime_role);
  IF EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name='communication') THEN EXECUTE format('GRANT USAGE ON SCHEMA communication TO %I',runtime_role); END IF;
  EXECUTE format('GRANT SELECT ON saas.modules,saas.bundle_modules,saas.module_capabilities,saas.tenant_memberships,saas.tenants,saas.subscriptions,saas.tenant_module_entitlements,saas.tenant_product_entitlements TO %I',runtime_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION saas.current_tenant_id(),saas.current_actor_user_id(),saas.tenant_matches(uuid),saas.module_entitled(uuid,text,timestamptz) TO %I',runtime_role);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON app.resources,app.resource_files,files.objects,crm.documents,recruiting.application_files TO %I',runtime_role);
  EXECUTE format('GRANT SELECT,INSERT ON audit.events TO %I',runtime_role);
  EXECUTE format('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA app,files,crm,recruiting,audit,integration TO %I',runtime_role);
  -- Connect remains route-blocked, but existing internal service calls require
  -- the same RLS-bound CRUD rights when the INTERNAL context is configured.
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA integration TO %I',runtime_role);
  IF EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name='communication') THEN EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA communication TO %I',runtime_role); EXECUTE format('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA communication TO %I',runtime_role); END IF;
END $grant_runtime$;
