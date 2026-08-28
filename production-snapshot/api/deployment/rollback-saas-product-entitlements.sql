-- Run only after WB_TENDER_SAAS_ENABLED=false has been applied to every Green
-- application instance. This preserves all SaaS records for investigation and
-- re-cutover; it does not touch the existing tender or IAM schemas.
BEGIN;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='tenant_portal') THEN
    RAISE EXCEPTION 'migration 081 present; use rollback-tenant-data-plane.sql';
  END IF;
  IF EXISTS(SELECT 1 FROM saas.subscriptions WHERE status IN('TRIAL_ACTIVE','ACTIVE','PAST_DUE')) THEN
    RAISE EXCEPTION 'refusing SaaS schema rollback while customer lifecycle is live';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='saas_rollback_080') THEN
    RAISE EXCEPTION 'saas_rollback_080 already exists';
  END IF;
END $$;
ALTER SCHEMA saas RENAME TO saas_rollback_080;
COMMIT;
