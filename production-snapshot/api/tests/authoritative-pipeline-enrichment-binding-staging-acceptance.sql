DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM tender.pipeline_contexts context
    JOIN tender.enrichment_context_bindings binding
      ON binding.enrichment_version_id=context.enrichment_version_id
      AND binding.tenant_id=context.tenant_id AND binding.company_id=context.company_id
      AND binding.tender_id=context.tender_id AND binding.lot_id=context.lot_id
      AND binding.source_lot_id=context.lot_key
    WHERE context.id='00000000-0000-4000-8000-000000001271'
      AND context.context_integrity_status='CANONICAL'
      AND context.context_integrity_reason IS NULL) THEN
    RAISE EXCEPTION 'authoritative_context_was_not_repaired_exactly';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.schema_migrations
    WHERE version='0127-authoritative-pipeline-enrichment-binding') THEN
    RAISE EXCEPTION 'migration_127_ledger_missing';
  END IF;
END $$;

SELECT 'authoritative_pipeline_binding_2_of_2' result;
