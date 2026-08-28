-- Green only. Requires the exact app.tenant_id and app.wb_backfill_run_id used
-- by deployment/backfill-wb-internal-tenant.sql. Legacy business rows were not
-- modified and therefore need no data reversal.
BEGIN;
DO $$
BEGIN
  IF EXISTS(
    SELECT 1 FROM saas.legacy_company_tenant_bindings
    WHERE tenant_id<>current_setting('app.tenant_id')::uuid
       OR backfill_run_id<>current_setting('app.wb_backfill_run_id')::uuid
  ) THEN RAISE EXCEPTION 'rollback_scope_mismatch'; END IF;
  IF EXISTS(SELECT 1 FROM saas.tenant_memberships WHERE tenant_id=current_setting('app.tenant_id')::uuid)
     OR EXISTS(SELECT 1 FROM saas.subscriptions WHERE tenant_id=current_setting('app.tenant_id')::uuid)
  THEN RAISE EXCEPTION 'rollback_refused_tenant_has_lifecycle_rows'; END IF;
END $$;
DELETE FROM saas.legacy_company_tenant_bindings
 WHERE tenant_id=current_setting('app.tenant_id')::uuid AND backfill_run_id=current_setting('app.wb_backfill_run_id')::uuid;
DELETE FROM saas.tenant_backfill_runs
 WHERE id=current_setting('app.wb_backfill_run_id')::uuid AND tenant_id=current_setting('app.tenant_id')::uuid;
DELETE FROM saas.tenants WHERE id=current_setting('app.tenant_id')::uuid AND tenant_kind='INTERNAL';
COMMIT;
