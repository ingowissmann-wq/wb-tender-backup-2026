INSERT INTO tender.configuration_tenants(id,tenant_key)
VALUES('00000000-0000-4000-8000-000000001250','context-127-tenant')
ON CONFLICT DO NOTHING;

INSERT INTO tender.configuration_scopes(tenant_id,company_id,canonical_service,profile_id)
VALUES('00000000-0000-4000-8000-000000001250','00000000-0000-4000-8000-000000001252',
  'security','00000000-0000-4000-8000-000000001251')
ON CONFLICT DO NOTHING;

INSERT INTO tender.tender_lot_lifecycles(tender_id,lot_key,lifecycle_status,participation_status,
  offer_deadline,deadline_quality,is_current)
VALUES('00000000-0000-4000-8000-000000001231','LOT-STAGING-3','ACTIVE','ELIGIBLE',
  '2099-01-01T12:00:00Z','EXACT',true)
ON CONFLICT DO NOTHING;

BEGIN;
-- Fixture-only: prevent the relevance insert from enqueueing any portal job.
-- The setting is transaction-local and is reset before the identity fixture.
SET LOCAL session_replication_role='replica';
INSERT INTO tender.service_relevance_evaluations(id,tender_id,enrichment_version_id,company_id,
  lot_key,evaluation_version,classifier_version,snapshot_sha256,relevance_status,service_scope_gate,
  primary_company,alternative_company,service_line,recommendation,reason)
VALUES('00000000-0000-4000-8000-000000001270','00000000-0000-4000-8000-000000001231',
  '00000000-0000-4000-8000-000000001240','00000000-0000-4000-8000-000000001252',
  'LOT-STAGING-3',1,'context-127/1.0.0',repeat('e',64),'RELEVANT','PASSED',true,false,
  'security','FULL_PIPELINE_ALLOWED','STAGING_EXACT_RELEVANCE')
ON CONFLICT DO NOTHING;
COMMIT;

INSERT INTO tender.pipeline_contexts(id,tender_id,lot_key,company_id,pipeline_version,current_step)
VALUES('00000000-0000-4000-8000-000000001271','00000000-0000-4000-8000-000000001231',
  'LOT-STAGING-3','00000000-0000-4000-8000-000000001252','context-127/1.0.0','DISCOVERED')
ON CONFLICT DO NOTHING;

-- Re-evaluate an idempotently retained fixture row after the canonical lot was
-- materialized by migration 123's lifecycle trigger.
UPDATE tender.pipeline_contexts SET current_step=current_step
WHERE id='00000000-0000-4000-8000-000000001271';

DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM tender.pipeline_contexts
    WHERE id='00000000-0000-4000-8000-000000001271'
      AND context_integrity_status='REPAIR_REQUIRED'
      AND context_integrity_reason='EXACT_ENRICHMENT_BINDING_MISSING') THEN
    RAISE EXCEPTION 'fixture_must_start_without_exact_binding';
  END IF;
END $$;
