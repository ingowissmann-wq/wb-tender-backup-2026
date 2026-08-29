\set ON_ERROR_STOP on
BEGIN;

-- Refuse rollback once the new manual module action contract has been used;
-- removing its catalog semantics would make an active audit history unclear.
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM saas.license_events
    WHERE event_type IN('MODULE_MANUAL_GRANT','MODULE_MANUAL_REVOKE','MODULE_MANUAL_SUSPEND'))
  THEN RAISE EXCEPTION 'rollback_refused_manual_module_history_exists'; END IF;
END $$;

DELETE FROM saas.commercial_product_modules
WHERE commercial_product_key='wb_business_suite_trial_14d'
  AND module_key IN('crm','flow','insights','connect');
INSERT INTO saas.commercial_product_blockers(commercial_product_key,module_key,blocker_code,safe_detail) VALUES
 ('wb_business_suite_trial_14d','crm','EXTERNAL_MODULE_NOT_READY','CRM is a secure empty shell and is not exposed to trial tenants.'),
 ('wb_business_suite_trial_14d','flow','EXTERNAL_MODULE_NOT_READY','Flow is a secure empty shell and is not exposed to trial tenants.'),
 ('wb_business_suite_trial_14d','insights','EXTERNAL_MODULE_NOT_READY','Insights is a secure empty shell and is not exposed to trial tenants.'),
 ('wb_business_suite_trial_14d','connect','EXTERNAL_MODULE_NOT_READY','Connect integrations are not configured for external trial tenants.')
ON CONFLICT(commercial_product_key,module_key) DO UPDATE
SET blocker_code=excluded.blocker_code,safe_detail=excluded.safe_detail;
DROP INDEX IF EXISTS saas.license_event_manual_module_audit;

COMMIT;
