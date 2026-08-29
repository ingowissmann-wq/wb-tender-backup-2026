BEGIN;

-- Green candidate only. This migration is additive to migration 100 and does
-- not insert a Stripe Price ID: no unambiguous real trial Price is present in
-- candidate configuration. Unknown and retired Prices therefore fail closed.
ALTER TABLE saas.products ADD COLUMN IF NOT EXISTS offer_class text NOT NULL DEFAULT 'REGULAR';
ALTER TABLE saas.products ADD COLUMN IF NOT EXISTS paid_trial_days smallint;
ALTER TABLE saas.products ADD COLUMN IF NOT EXISTS expected_currency char(3);
ALTER TABLE saas.products ADD COLUMN IF NOT EXISTS expected_amount_minor bigint;
ALTER TABLE saas.products DROP CONSTRAINT IF EXISTS saas_products_offer_class_chk;
ALTER TABLE saas.products ADD CONSTRAINT saas_products_offer_class_chk
  CHECK(offer_class IN('REGULAR','PAID_TRIAL'));
ALTER TABLE saas.products DROP CONSTRAINT IF EXISTS saas_products_paid_trial_contract_chk;
ALTER TABLE saas.products ADD CONSTRAINT saas_products_paid_trial_contract_chk CHECK(
  (offer_class='REGULAR' AND paid_trial_days IS NULL)
  OR (offer_class='PAID_TRIAL' AND paid_trial_days=14 AND expected_currency='EUR' AND expected_amount_minor=19900)
);

INSERT INTO saas.products(product_key,slug,display_name,description,product_type,offer_class,paid_trial_days,
 expected_currency,expected_amount_minor,active,metadata,limits)
VALUES('wb_business_suite_trial_14d','wb-business-suite-trial-14d','WB Business Suite – 14-day paid test',
 'One paid 14-day test of the externally safe WB Business Suite modules.','SUITE','PAID_TRIAL',14,'EUR',19900,true,
 '{"catalog_version":101,"stripe_price_mapping":"REQUIRED_NOT_CONFIGURED","external_submission":false}'::jsonb,
 '{"duration_days":14,"one_trial_per_identity_and_company":true}'::jsonb)
ON CONFLICT(product_key) DO UPDATE SET display_name=excluded.display_name,description=excluded.description,
 product_type=excluded.product_type,offer_class=excluded.offer_class,paid_trial_days=excluded.paid_trial_days,
 expected_currency=excluded.expected_currency,expected_amount_minor=excluded.expected_amount_minor,
 metadata=saas.products.metadata||excluded.metadata,limits=excluded.limits,updated_at=now();

-- Only modules with a tenant-isolated external data plane are exposed. Empty
-- shells and incomplete integration modules remain fail-closed and observable.
WITH safe(module_key) AS (VALUES
 ('tender_scout'),('tender_autopilot'),('csm'),('people'),('docs'),('control')
)
INSERT INTO saas.commercial_product_modules(commercial_product_key,module_key,exposure,metadata)
SELECT 'wb_business_suite_trial_14d',module_key,'EXPOSED','{"safety_review":101}'::jsonb FROM safe
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS saas.commercial_product_blockers(
  commercial_product_key text NOT NULL REFERENCES saas.products(product_key) ON DELETE CASCADE,
  module_key text NOT NULL REFERENCES saas.modules(module_key) ON DELETE RESTRICT,
  blocker_code text NOT NULL,
  safe_detail text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(commercial_product_key,module_key)
);
INSERT INTO saas.commercial_product_blockers(commercial_product_key,module_key,blocker_code,safe_detail) VALUES
 ('wb_business_suite_trial_14d','crm','EXTERNAL_MODULE_NOT_READY','CRM is a secure empty shell and is not exposed to trial tenants.'),
 ('wb_business_suite_trial_14d','flow','EXTERNAL_MODULE_NOT_READY','Flow is a secure empty shell and is not exposed to trial tenants.'),
 ('wb_business_suite_trial_14d','insights','EXTERNAL_MODULE_NOT_READY','Insights is a secure empty shell and is not exposed to trial tenants.'),
 ('wb_business_suite_trial_14d','connect','EXTERNAL_MODULE_NOT_READY','Connect integrations are not configured for external trial tenants.')
ON CONFLICT(commercial_product_key,module_key) DO UPDATE SET blocker_code=excluded.blocker_code,safe_detail=excluded.safe_detail;

ALTER TABLE saas.tenants ADD COLUMN IF NOT EXISTS company_identity_hash text;
CREATE INDEX IF NOT EXISTS saas_tenants_company_identity_lookup
  ON saas.tenants(company_identity_hash) WHERE company_identity_hash IS NOT NULL;
ALTER TABLE saas.trial_claims ADD COLUMN IF NOT EXISTS company_identity_hash text;
ALTER TABLE saas.trial_claims ADD COLUMN IF NOT EXISTS license_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS trial_claim_company_once
  ON saas.trial_claims(company_identity_hash) WHERE company_identity_hash IS NOT NULL;

ALTER TABLE saas.tenant_product_licenses ADD COLUMN IF NOT EXISTS provider_payment_ref text;
CREATE UNIQUE INDEX IF NOT EXISTS tenant_license_provider_payment
  ON saas.tenant_product_licenses(provider,provider_payment_ref) WHERE provider_payment_ref IS NOT NULL;
DO $drop_old_stripe_check$
DECLARE item record;
BEGIN
  FOR item IN SELECT conname FROM pg_constraint
    WHERE conrelid='saas.tenant_product_licenses'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%source%STRIPE%provider_subscription_ref%'
  LOOP EXECUTE format('ALTER TABLE saas.tenant_product_licenses DROP CONSTRAINT %I',item.conname); END LOOP;
END $drop_old_stripe_check$;
ALTER TABLE saas.tenant_product_licenses DROP CONSTRAINT IF EXISTS tenant_product_licenses_provider_binding_chk;
ALTER TABLE saas.tenant_product_licenses ADD CONSTRAINT tenant_product_licenses_provider_binding_chk CHECK(
 (source='STRIPE' AND provider='stripe' AND offer_id IS NOT NULL
   AND ((provider_subscription_ref IS NOT NULL) <> (provider_payment_ref IS NOT NULL)))
 OR (source<>'STRIPE' AND provider IS NULL AND offer_id IS NULL AND provider_customer_ref IS NULL
   AND provider_subscription_ref IS NULL AND provider_payment_ref IS NULL)
);
ALTER TABLE saas.tenant_product_licenses DROP CONSTRAINT IF EXISTS tenant_product_licenses_trial_window_chk;
ALTER TABLE saas.tenant_product_licenses ADD CONSTRAINT tenant_product_licenses_trial_window_chk CHECK(
 (status<>'TRIAL_ACTIVE' OR (trial_started_at IS NOT NULL AND trial_ends_at=trial_started_at+interval '14 days'))
 AND (trial_ends_at IS NULL OR trial_started_at IS NOT NULL)
);
ALTER TABLE saas.trial_claims DROP CONSTRAINT IF EXISTS trial_claims_license_fk;
ALTER TABLE saas.trial_claims ADD CONSTRAINT trial_claims_license_fk
  FOREIGN KEY(license_id) REFERENCES saas.tenant_product_licenses(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS saas.trial_reminder_deliveries(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE RESTRICT,
  license_id uuid NOT NULL REFERENCES saas.tenant_product_licenses(id) ON DELETE RESTRICT,
  offset_days smallint NOT NULL CHECK(offset_days BETWEEN 1 AND 13),
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','DISPATCHING','FAILED','SENT','DELIVERY_UNKNOWN','CANCELED')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid, claimed_at timestamptz, sent_at timestamptz,
  provider_message_id text, last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(license_id,offset_days), UNIQUE(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS trial_reminder_due_queue
  ON saas.trial_reminder_deliveries(status,next_attempt_at,due_at);
CREATE INDEX IF NOT EXISTS paid_trial_expiry_queue
  ON saas.tenant_product_licenses(trial_ends_at,id) WHERE status='TRIAL_ACTIVE';

ALTER TABLE saas.trial_reminder_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.trial_reminder_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON saas.trial_reminder_deliveries;
CREATE POLICY tenant_isolation ON saas.trial_reminder_deliveries
  USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));

REVOKE ALL ON saas.commercial_product_blockers,saas.trial_reminder_deliveries FROM PUBLIC;
COMMIT;
