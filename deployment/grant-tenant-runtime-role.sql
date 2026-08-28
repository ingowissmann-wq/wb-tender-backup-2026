-- Run as the migration owner on Green after setting app.runtime_role to the
-- existing least-privilege web runtime role. Refuses missing/unknown roles.
BEGIN;
DO $$
DECLARE role_name text := nullif(current_setting('app.runtime_role',true),'');
BEGIN
  IF role_name IS NULL OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name)
    THEN RAISE EXCEPTION 'configured_runtime_role_not_found';
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA saas,tenant_portal TO %I',role_name);
  EXECUTE format('GRANT SELECT ON saas.plans,saas.plan_entitlements,saas.modules,saas.products,saas.bundle_modules,saas.module_capabilities,saas.module_dependencies TO %I',role_name);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON saas.tenants,saas.pending_registrations,saas.tenant_memberships,saas.tenant_companies,saas.subscriptions,saas.trial_claims,saas.billing_events,saas.audit_events,saas.saved_searches,saas.tenant_module_entitlements,saas.tenant_product_entitlements,saas.tenant_invitations,saas.checkout_sessions TO %I',role_name);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA tenant_portal TO %I',role_name);
  EXECUTE format('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA saas,tenant_portal TO %I',role_name);
  EXECUTE format('GRANT EXECUTE ON FUNCTION saas.current_tenant_id(),saas.current_actor_user_id(),saas.tenant_matches(uuid),saas.module_entitled(uuid,text,timestamptz),saas.module_capability_allowed(uuid,text,text,timestamptz),saas.configure_commercial_entitlements(uuid,text,text[]),tenant_portal.provision_empty_tenant(uuid,text),tenant_portal.enable_synthetic_demo(uuid),tenant_portal.claim_module_job(uuid,uuid) TO %I',role_name);
END $$;
COMMIT;
