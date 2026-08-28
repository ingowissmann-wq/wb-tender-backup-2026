\set ON_ERROR_STOP on

INSERT INTO tender.pipeline_contexts(id,tender_id,lot_key,company_id,pipeline_version,current_step)
VALUES('00000000-0000-4000-8000-000000001259','00000000-0000-4000-8000-000000001231','',
  '00000000-0000-4000-8000-000000001252','context/125-old-app','SOURCE_RESOLVED');

DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM tender.pipeline_contexts
      WHERE id='00000000-0000-4000-8000-000000001259' AND tenant_id IS NULL) THEN
    RAISE EXCEPTION 'old_application_insert_not_rollback_compatible';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM tender.pipeline_contexts
      WHERE id='00000000-0000-4000-8000-000000001256'
        AND tenant_id='00000000-0000-4000-8000-000000001250'
        AND lot_id IS NOT NULL AND enrichment_version_id IS NOT NULL) THEN
    RAISE EXCEPTION 'down_migration_changed_backfilled_identity';
  END IF;
  IF EXISTS(SELECT 1 FROM app.schema_migrations
      WHERE version='0125-pipeline-context-exact-identity') THEN
    RAISE EXCEPTION 'down_migration_125_ledger_entry_retained';
  END IF;
END $$;

SELECT 'pipeline_context_exact_identity_rollback_3_of_3' result;
