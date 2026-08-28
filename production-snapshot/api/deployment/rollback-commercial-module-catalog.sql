-- Green-only rollback for migration 082. Application rollback is always first:
-- set WB_TENDER_SAAS_ENABLED=false. This database rollback refuses any live
-- module/product entitlement so commercial evidence is never silently lost.
BEGIN;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM saas.tenant_product_entitlements WHERE enabled)
     OR EXISTS(SELECT 1 FROM saas.tenant_module_entitlements WHERE source<>'BASELINE') THEN
    RAISE EXCEPTION 'rollback_refused_live_commercial_entitlements';
  END IF;
END $$;
DROP FUNCTION IF EXISTS tenant_portal.claim_module_job(uuid,uuid);
DROP FUNCTION IF EXISTS saas.module_capability_allowed(uuid,text,text,timestamptz);
DROP FUNCTION IF EXISTS saas.module_entitled(uuid,text,timestamptz);
DROP FUNCTION IF EXISTS saas.configure_commercial_entitlements(uuid,text,text[]);
ALTER TABLE tenant_portal.jobs DROP COLUMN IF EXISTS module_key;
ALTER TABLE saas.subscriptions DROP COLUMN IF EXISTS commercial_scope;
DROP TABLE IF EXISTS saas.tenant_product_entitlements;
DROP TABLE IF EXISTS saas.tenant_module_entitlements;
DROP TABLE IF EXISTS saas.module_dependencies;
DROP TABLE IF EXISTS saas.module_capabilities;
DROP TABLE IF EXISTS saas.bundle_modules;
DROP TABLE IF EXISTS saas.products;
DROP TABLE IF EXISTS saas.modules;
CREATE OR REPLACE FUNCTION tenant_portal.provision_empty_tenant(candidate uuid,organization_name text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF NOT saas.tenant_matches(candidate) THEN RAISE EXCEPTION 'tenant_context_required'; END IF;
  IF organization_name IS NULL OR length(trim(organization_name)) NOT BETWEEN 2 AND 160 THEN RAISE EXCEPTION 'organization_name_invalid'; END IF;
  INSERT INTO tenant_portal.organizations(tenant_id,display_name) VALUES(candidate,trim(organization_name)) ON CONFLICT(tenant_id) DO NOTHING;
  INSERT INTO tenant_portal.tenant_settings(tenant_id,demo_data_enabled) VALUES(candidate,false) ON CONFLICT(tenant_id) DO NOTHING;
END $$;
COMMIT;
