\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM tender.pipeline_contexts
      WHERE id='00000000-0000-4000-8000-000000001256'
        AND tenant_id='00000000-0000-4000-8000-000000001250'
        AND lot_id IS NOT NULL
        AND enrichment_version_id='00000000-0000-4000-8000-000000001240'
        AND context_integrity_status='CANONICAL' AND context_integrity_reason IS NULL) THEN
    RAISE EXCEPTION 'canonical_pipeline_context_not_exactly_bound';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM tender.pipeline_contexts
      WHERE id='00000000-0000-4000-8000-000000001257'
        AND tenant_id='00000000-0000-4000-8000-000000001250'
        AND lot_id IS NULL
        AND enrichment_version_id='00000000-0000-4000-8000-000000001240'
        AND context_integrity_status='TENDER_GLOBAL') THEN
    RAISE EXCEPTION 'tender_global_pipeline_context_not_bound';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM tender.pipeline_contexts
      WHERE id='00000000-0000-4000-8000-000000001258'
        AND lot_id IS NULL AND enrichment_version_id IS NULL
        AND context_integrity_status='REPAIR_REQUIRED'
        AND context_integrity_reason='CANONICAL_LOT_MISSING') THEN
    RAISE EXCEPTION 'missing_lot_pipeline_context_not_fail_closed';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.schema_migrations
      WHERE version='0125-pipeline-context-exact-identity') THEN
    RAISE EXCEPTION 'migration_125_ledger_missing';
  END IF;
END $$;

SELECT 'pipeline_context_exact_identity_4_of_4' result;
