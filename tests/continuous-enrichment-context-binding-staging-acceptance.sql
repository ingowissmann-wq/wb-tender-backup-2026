BEGIN;

INSERT INTO tender.pipeline_contexts(id,tender_id,lot_key,company_id,pipeline_version,current_step)
VALUES('00000000-0000-4000-8000-000000001269','00000000-0000-4000-8000-000000001231',
  'LOT-STAGING-2','00000000-0000-4000-8000-000000001252','context-126/1.0.0','DISCOVERED');

DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM tender.pipeline_contexts
    WHERE id='00000000-0000-4000-8000-000000001269'
      AND context_integrity_status='REPAIR_REQUIRED'
      AND context_integrity_reason='EXACT_ENRICHMENT_BINDING_MISSING') THEN
    RAISE EXCEPTION 'context_should_start_fail_closed_without_exact_binding';
  END IF;
END $$;

INSERT INTO tender.enrichment_context_bindings(enrichment_version_id,tenant_id,company_id,tender_id,
  tender_version_id,lot_id,source_lot_id,canonical_service,source_manifest_sha256)
SELECT '00000000-0000-4000-8000-000000001240','00000000-0000-4000-8000-000000001250',
  '00000000-0000-4000-8000-000000001252','00000000-0000-4000-8000-000000001231',
  '00000000-0000-4000-8000-000000001255',lot.id,'LOT-STAGING-2','security',repeat('a',64)
FROM tender.lots lot WHERE lot.tender_id='00000000-0000-4000-8000-000000001231'
  AND lot.external_id='LOT-STAGING-2';

UPDATE tender.pipeline_contexts SET current_step='ENRICHMENT_MATERIALIZED'
WHERE id='00000000-0000-4000-8000-000000001269';

DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM tender.pipeline_contexts
    WHERE id='00000000-0000-4000-8000-000000001269'
      AND lot_id IS NOT NULL
      AND enrichment_version_id='00000000-0000-4000-8000-000000001240'
      AND context_integrity_status='CANONICAL' AND context_integrity_reason IS NULL) THEN
    RAISE EXCEPTION 'ordinary_pipeline_refresh_did_not_adopt_exact_binding';
  END IF;
END $$;

ROLLBACK;
