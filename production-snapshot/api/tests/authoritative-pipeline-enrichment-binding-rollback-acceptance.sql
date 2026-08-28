DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM tender.pipeline_contexts
    WHERE id='00000000-0000-4000-8000-000000001271'
      AND context_integrity_status='CANONICAL' AND enrichment_version_id IS NOT NULL) THEN
    RAISE EXCEPTION 'expand_only_rollback_lost_repaired_context';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM tender.enrichment_context_bindings binding
    WHERE binding.company_id='00000000-0000-4000-8000-000000001252'
      AND binding.source_lot_id='LOT-STAGING-3') THEN
    RAISE EXCEPTION 'expand_only_rollback_lost_exact_binding';
  END IF;
  IF EXISTS(SELECT 1 FROM app.schema_migrations
    WHERE version='0127-authoritative-pipeline-enrichment-binding') THEN
    RAISE EXCEPTION 'migration_127_ledger_should_be_removed';
  END IF;
END $$;
