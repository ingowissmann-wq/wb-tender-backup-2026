-- Run only after WB_TENDER_SAAS_ENABLED=false is confirmed on every Green
-- instance. This is a preservation rollback: no customer record is deleted.
BEGIN;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM saas.subscriptions WHERE status IN('TRIAL_ACTIVE','ACTIVE','PAST_DUE'))
    THEN RAISE EXCEPTION 'refusing tenant data-plane rollback while customer lifecycle is live';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN('saas_rollback_081','tenant_portal_rollback_081'))
    THEN RAISE EXCEPTION 'tenant data-plane rollback schema already exists';
  END IF;
END $$;
ALTER SCHEMA tenant_portal RENAME TO tenant_portal_rollback_081;
ALTER SCHEMA saas RENAME TO saas_rollback_081;
COMMIT;
