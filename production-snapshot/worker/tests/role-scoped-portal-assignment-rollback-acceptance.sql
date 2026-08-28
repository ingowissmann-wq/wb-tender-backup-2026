DO $$
BEGIN
  IF to_regclass('tender.current_tender_company_portal_role_scopes') IS NOT NULL THEN
    RAISE EXCEPTION 'role_scope_view_should_be_removed_by_rollback';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='tender' AND table_name='tender_portal_assignments' AND column_name='portal_role') THEN
    RAISE EXCEPTION 'expand_only_rollback_must_retain_role_data_column';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='tender'
    AND indexname='tender_portal_assignments_active_role_scope_uq') THEN
    RAISE EXCEPTION 'expand_only_rollback_must_retain_noncollapsing_unique_index';
  END IF;
  IF EXISTS(SELECT 1 FROM app.schema_migrations
    WHERE version='0126-role-scoped-tender-portal-assignments') THEN
    RAISE EXCEPTION 'migration_ledger_should_be_removed_by_rollback';
  END IF;
END $$;
