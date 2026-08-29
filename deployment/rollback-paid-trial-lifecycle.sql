-- Candidate rollback for migration 101. Disable SaaS and stop the dedicated
-- trial lifecycle worker first. Customer data and audit history are protected.
BEGIN;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM saas.tenant_product_licenses WHERE commercial_product_key='wb_business_suite_trial_14d')
     OR EXISTS(SELECT 1 FROM saas.trial_reminder_deliveries) THEN
    RAISE EXCEPTION 'rollback_refused_paid_trial_history_present';
  END IF;
END $$;
DROP TABLE IF EXISTS saas.trial_reminder_deliveries;
DROP INDEX IF EXISTS saas.paid_trial_expiry_queue;
ALTER TABLE saas.trial_claims DROP CONSTRAINT IF EXISTS trial_claims_license_fk;
DROP INDEX IF EXISTS saas.trial_claim_company_once;
ALTER TABLE saas.trial_claims DROP COLUMN IF EXISTS license_id;
ALTER TABLE saas.trial_claims DROP COLUMN IF EXISTS company_identity_hash;
DROP INDEX IF EXISTS saas.saas_tenants_company_identity_lookup;
ALTER TABLE saas.tenants DROP COLUMN IF EXISTS company_identity_hash;
DROP TABLE IF EXISTS saas.commercial_product_blockers;
DELETE FROM saas.commercial_product_modules WHERE commercial_product_key='wb_business_suite_trial_14d';
DELETE FROM saas.products WHERE product_key='wb_business_suite_trial_14d';
DROP INDEX IF EXISTS saas.tenant_license_provider_payment;
ALTER TABLE saas.tenant_product_licenses DROP COLUMN IF EXISTS provider_payment_ref;
ALTER TABLE saas.tenant_product_licenses DROP CONSTRAINT IF EXISTS tenant_product_licenses_provider_binding_chk;
ALTER TABLE saas.tenant_product_licenses ADD CONSTRAINT tenant_product_licenses_provider_binding_chk CHECK(
  (source='STRIPE' AND provider='stripe' AND offer_id IS NOT NULL AND provider_subscription_ref IS NOT NULL)
  OR (source<>'STRIPE' AND provider IS NULL AND offer_id IS NULL AND provider_customer_ref IS NULL AND provider_subscription_ref IS NULL)
);
ALTER TABLE saas.products DROP CONSTRAINT IF EXISTS saas_products_paid_trial_contract_chk;
ALTER TABLE saas.products DROP CONSTRAINT IF EXISTS saas_products_offer_class_chk;
ALTER TABLE saas.products DROP COLUMN IF EXISTS expected_amount_minor;
ALTER TABLE saas.products DROP COLUMN IF EXISTS expected_currency;
ALTER TABLE saas.products DROP COLUMN IF EXISTS paid_trial_days;
ALTER TABLE saas.products DROP COLUMN IF EXISTS offer_class;
COMMIT;
