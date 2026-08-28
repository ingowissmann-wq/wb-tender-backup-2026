BEGIN;

-- NEW Green only. Completes the data-driven package catalog without touching
-- legacy plan compatibility, Stripe offers, tenant data, or Tender runtime.
UPDATE saas.products SET metadata=metadata||'{"catalog_version":105,"new_commercial_model":true}'::jsonb,updated_at=now()
WHERE product_key IN(
  'wb_tender_scout','wb_tender_autopilot','wb_tender_professional','wb_tender_enterprise',
  'wb_crm','wb_csm','wb_flow','wb_people','wb_docs','wb_insights','wb_business_suite'
);

-- The existing paid Business Suite trial keeps its immutable payment and
-- elapsed-time contract. It exposes the same ten canonical modules as the
-- regular Business Suite; expiry only removes access and never deletes data.
INSERT INTO saas.commercial_product_modules(commercial_product_key,module_key,exposure,metadata)
SELECT 'wb_business_suite_trial_14d',module_key,'EXPOSED','{"catalog_version":105,"full_suite_trial":true,"data_retained_on_expiry":true}'::jsonb
FROM saas.modules WHERE active
ON CONFLICT(commercial_product_key,module_key,exposure) DO UPDATE
SET metadata=saas.commercial_product_modules.metadata||excluded.metadata;
DELETE FROM saas.commercial_product_blockers
WHERE commercial_product_key='wb_business_suite_trial_14d'
  AND module_key IN('crm','flow','insights','connect');
UPDATE saas.products SET metadata=metadata||'{"catalog_version":105,"full_suite_trial":true,"data_retained_on_expiry":true}'::jsonb,updated_at=now()
WHERE product_key='wb_business_suite_trial_14d';

-- Catalog postconditions. Control is bundled where administration is needed,
-- while the full suite contains each canonical module exactly once.
DO $$
DECLARE missing_product text; module_count integer;
BEGIN
  SELECT p.product_key INTO missing_product FROM saas.products p
  WHERE p.active AND p.offer_class='REGULAR' AND p.product_type IN('STANDALONE','BUNDLE')
    AND p.product_key IN('wb_tender_scout','wb_tender_autopilot','wb_tender_professional','wb_tender_enterprise','wb_crm','wb_csm','wb_flow','wb_people','wb_docs','wb_insights')
    AND NOT EXISTS(SELECT 1 FROM saas.commercial_product_modules pm
      WHERE pm.commercial_product_key=p.product_key AND pm.module_key='control' AND pm.exposure='EXPOSED')
  LIMIT 1;
  IF missing_product IS NOT NULL THEN RAISE EXCEPTION 'commercial_product_control_missing:%',missing_product; END IF;

  SELECT count(DISTINCT module_key) INTO module_count FROM saas.commercial_product_modules
  WHERE commercial_product_key='wb_business_suite' AND exposure='EXPOSED';
  IF module_count<>10 THEN RAISE EXCEPTION 'business_suite_canonical_module_count_invalid:%',module_count; END IF;
  SELECT count(DISTINCT module_key) INTO module_count FROM saas.commercial_product_modules
  WHERE commercial_product_key='wb_business_suite_trial_14d' AND exposure='EXPOSED';
  IF module_count<>10 THEN RAISE EXCEPTION 'business_suite_trial_canonical_module_count_invalid:%',module_count; END IF;
END $$;

-- Explicit module override history is recorded in license_events. Retaining it
-- is mandatory because revokes override every inherited product grant.
CREATE INDEX IF NOT EXISTS license_event_manual_module_audit
  ON saas.license_events(tenant_id,event_type,occurred_at DESC)
  WHERE event_type IN('MODULE_MANUAL_GRANT','MODULE_MANUAL_REVOKE','MODULE_MANUAL_SUSPEND');

COMMIT;
