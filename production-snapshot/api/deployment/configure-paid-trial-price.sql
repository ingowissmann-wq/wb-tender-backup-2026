-- NEW Green only. Deterministic mapping for the tender-specific, human-supplied
-- Stripe Price ID. Before applying, independently retrieve this Price from
-- Stripe and verify: active, EUR 199.00, one-time. Migration 101 supplies the
-- separate immutable 14-elapsed-day product contract.
--
--   psql "$GREEN_DATABASE_URL" -f deployment/configure-paid-trial-price.sql
--
-- This artifact is safe to reapply only when the exact canonical row already
-- exists. Any retired, alternate, or conflicting Price/offer mapping aborts.
\set ON_ERROR_STOP on
BEGIN;
LOCK TABLE saas.stripe_price_offers IN SHARE ROW EXCLUSIVE MODE;
SELECT set_config('app.stripe_trial_price_id', 'price_1U5VsIE0SiqbbyKf1wdyWTUR', true);
DO $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM saas.products
    WHERE product_key='wb_business_suite_trial_14d' AND active
      AND offer_class='PAID_TRIAL' AND paid_trial_days=14
      AND expected_currency='EUR' AND expected_amount_minor=19900
  ) THEN RAISE EXCEPTION 'paid_trial_product_contract_missing';
  END IF;
  IF EXISTS(
    SELECT 1 FROM saas.stripe_price_offers
    WHERE (commercial_product_key='wb_business_suite_trial_14d'
       OR stripe_price_id=current_setting('app.stripe_trial_price_id')
       OR offer_key='wb_business_suite_trial_14d_eur_199')
      AND (provider IS DISTINCT FROM 'stripe'
        OR stripe_price_id IS DISTINCT FROM current_setting('app.stripe_trial_price_id')
        OR commercial_product_key IS DISTINCT FROM 'wb_business_suite_trial_14d'
        OR offer_key IS DISTINCT FROM 'wb_business_suite_trial_14d_eur_199'
        OR status IS DISTINCT FROM 'ACTIVE' OR currency IS DISTINCT FROM 'EUR'
        OR billing_interval IS DISTINCT FROM 'ONE_TIME' OR interval_count IS DISTINCT FROM 1
        OR amount_minor IS DISTINCT FROM 19900 OR valid_from IS NULL OR retired_at IS NOT NULL)
  ) THEN RAISE EXCEPTION 'paid_trial_price_mapping_conflict';
  END IF;
END $$;
INSERT INTO saas.stripe_price_offers(stripe_price_id,commercial_product_key,offer_key,status,currency,billing_interval,interval_count,amount_minor,provider_metadata,valid_from)
SELECT current_setting('app.stripe_trial_price_id'),'wb_business_suite_trial_14d','wb_business_suite_trial_14d_eur_199','ACTIVE','EUR','ONE_TIME',1,19900,
 '{"price_id_source":"tender_specific_human_supplied","expected_contract":"EUR_19900_ONE_TIME_14_ELAPSED_DAYS","migration":101}'::jsonb,now()
WHERE NOT EXISTS(
  SELECT 1 FROM saas.stripe_price_offers
  WHERE provider='stripe' AND stripe_price_id=current_setting('app.stripe_trial_price_id')
    AND commercial_product_key='wb_business_suite_trial_14d'
    AND offer_key='wb_business_suite_trial_14d_eur_199' AND status='ACTIVE'
    AND currency='EUR' AND billing_interval='ONE_TIME' AND interval_count=1 AND amount_minor=19900
);
DO $$
BEGIN
  IF (SELECT count(*) FROM saas.stripe_price_offers
      WHERE provider='stripe' AND stripe_price_id=current_setting('app.stripe_trial_price_id')
        AND commercial_product_key='wb_business_suite_trial_14d'
        AND offer_key='wb_business_suite_trial_14d_eur_199' AND status='ACTIVE'
        AND currency='EUR' AND billing_interval='ONE_TIME' AND interval_count=1
        AND amount_minor=19900 AND valid_from IS NOT NULL AND retired_at IS NULL) <> 1
  THEN RAISE EXCEPTION 'paid_trial_price_mapping_postcondition_failed';
  END IF;
END $$;
COMMIT;
