-- Exact rollback for migration 100. Disable WB_TENDER_SAAS_ENABLED first.
-- Refuse rollback whenever any license, offer or license audit would be lost.
BEGIN;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM saas.tenant_product_licenses)
     OR EXISTS(SELECT 1 FROM saas.stripe_price_offers)
     OR EXISTS(SELECT 1 FROM saas.license_events) THEN
    RAISE EXCEPTION 'rollback_refused_commercial_license_data_present';
  END IF;
END $$;
DROP FUNCTION IF EXISTS saas.effective_tenant_modules(uuid,timestamptz);
DROP TABLE IF EXISTS saas.license_events;
DROP TABLE IF EXISTS saas.tenant_product_licenses;
ALTER TABLE saas.checkout_sessions DROP COLUMN IF EXISTS offer_id;
ALTER TABLE saas.checkout_sessions DROP COLUMN IF EXISTS stripe_price_id;
ALTER TABLE saas.checkout_sessions DROP COLUMN IF EXISTS commercial_product_key;
DROP TABLE IF EXISTS saas.stripe_price_offers;
DROP TABLE IF EXISTS saas.commercial_product_capabilities;
DROP TABLE IF EXISTS saas.commercial_product_modules;
DELETE FROM saas.products WHERE product_key IN('wb_tender_scout','wb_tender_autopilot','wb_tender_professional','wb_tender_enterprise','wb_crm','wb_csm','wb_flow','wb_people','wb_docs','wb_insights','wb_legacy_core','wb_legacy_normal','wb_legacy_professional','wb_legacy_enterprise');
ALTER TABLE saas.products DROP COLUMN IF EXISTS updated_at;
ALTER TABLE saas.products DROP COLUMN IF EXISTS limits;
ALTER TABLE saas.products DROP COLUMN IF EXISTS past_due_access;
ALTER TABLE saas.products DROP COLUMN IF EXISTS legacy_plan_code;
ALTER TABLE saas.products DROP COLUMN IF EXISTS product_type;
CREATE OR REPLACE FUNCTION saas.module_entitled(candidate uuid,candidate_module text,at_time timestamptz DEFAULT now()) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH subscription_access AS (
    SELECT s.plan_code,s.commercial_scope FROM saas.subscriptions s JOIN saas.tenants t ON t.id=s.tenant_id
    WHERE s.tenant_id=candidate AND saas.tenant_matches(candidate) AND t.status='ACTIVE'
      AND (s.status='ACTIVE' AND (s.current_period_ends_at IS NULL OR s.current_period_ends_at>at_time)
        OR s.status='TRIAL_ACTIVE' AND s.trial_ends_at>at_time)
  ), explicit AS (
    SELECT enabled FROM saas.tenant_module_entitlements
    WHERE tenant_id=candidate AND module_key=candidate_module AND starts_at<=at_time AND (ends_at IS NULL OR ends_at>at_time)
  )
  SELECT EXISTS(SELECT 1 FROM subscription_access) AND coalesce(
    (SELECT enabled FROM explicit),
    EXISTS(SELECT 1 FROM subscription_access s JOIN saas.bundle_modules b ON b.plan_code=s.plan_code WHERE s.commercial_scope='BUNDLE' AND b.module_key=candidate_module)
      OR EXISTS(SELECT 1 FROM subscription_access s JOIN saas.tenant_product_entitlements p ON p.tenant_id=candidate WHERE s.commercial_scope='SUITE' AND p.product_key='wb_business_suite' AND p.enabled AND p.starts_at<=at_time AND (p.ends_at IS NULL OR p.ends_at>at_time)),
    false)
$$;
COMMIT;
