BEGIN;

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15min';

INSERT INTO tender.context_backfill_runs(release_id,before_counts,external_submission_enabled)
VALUES('20260825-authoritative-pipeline-enrichment-binding-127.1',jsonb_build_object(
  'pipeline_contexts_repair_required',(SELECT count(*) FROM tender.pipeline_contexts
    WHERE context_integrity_status='REPAIR_REQUIRED'),
  'enrichment_context_bindings',(SELECT count(*) FROM tender.enrichment_context_bindings),
  'physical_deletes',0
),false)
ON CONFLICT(release_id) DO NOTHING;

WITH candidates AS(
  SELECT DISTINCT ON(context.id)
    enrichment.id enrichment_version_id,scope.tenant_id,context.company_id,context.tender_id,
    version.id tender_version_id,lot.id lot_id,context.lot_key source_lot_id,
    scope.canonical_service,enrichment.payload_sha256 source_manifest_sha256
  FROM tender.pipeline_contexts context
  JOIN tender.tenders tender ON tender.id=context.tender_id
    AND tender.source_lifecycle_status='ACTIVE'
  JOIN tender.enterprise_company_links company ON company.company_id=context.company_id
    AND company.active=true
  JOIN tender.configuration_scopes scope ON scope.company_id=context.company_id
    AND scope.profile_id=company.tender_profile_id
  JOIN tender.lots lot ON lot.tender_id=context.tender_id AND lot.external_id=context.lot_key
  JOIN LATERAL(SELECT candidate.id,candidate.payload_sha256 FROM tender.enrichment_versions candidate
    WHERE candidate.tender_id=context.tender_id AND candidate.historical=false
      AND candidate.payload_sha256 ~ '^[0-9a-f]{64}$'
    ORDER BY candidate.version DESC,candidate.created_at DESC,candidate.id DESC LIMIT 1)enrichment ON true
  JOIN LATERAL(SELECT candidate.id FROM tender.tender_versions candidate
    WHERE candidate.tender_id=context.tender_id
    ORDER BY candidate.version DESC,candidate.created_at DESC,candidate.id DESC LIMIT 1)version ON true
  WHERE context.lot_key<>'' AND (
    EXISTS(SELECT 1 FROM tender.current_service_relevance relevance
      WHERE relevance.tender_id=context.tender_id AND relevance.company_id=context.company_id
        AND relevance.lot_key=context.lot_key AND relevance.relevance_status='RELEVANT'
        AND relevance.service_scope_gate='PASSED' AND relevance.primary_company=true)
    OR EXISTS(SELECT 1 FROM tender.tender_lot_selections selection
      WHERE selection.tenant_id=scope.tenant_id AND selection.company_id=context.company_id
        AND selection.tender_id=context.tender_id AND selection.source_lot_id=context.lot_key
        AND selection.lot_id=lot.id)
  )
  ORDER BY context.id,enrichment.id
)
INSERT INTO tender.enrichment_context_bindings(enrichment_version_id,tenant_id,company_id,tender_id,
  tender_version_id,lot_id,source_lot_id,canonical_service,source_manifest_sha256)
SELECT enrichment_version_id,tenant_id,company_id,tender_id,tender_version_id,lot_id,
  source_lot_id,canonical_service,source_manifest_sha256
FROM candidates
ON CONFLICT DO NOTHING;

-- The trigger from migration 125 recomputes all derived identities. This
-- updates no business choice and only promotes contexts with an exact binding.
UPDATE tender.pipeline_contexts context SET company_id=context.company_id
WHERE context.lot_key<>'' AND EXISTS(
  SELECT 1 FROM tender.enrichment_context_bindings binding
  JOIN tender.enrichment_versions enrichment ON enrichment.id=binding.enrichment_version_id
    AND enrichment.historical=false
  WHERE binding.tenant_id=context.tenant_id AND binding.company_id=context.company_id
    AND binding.tender_id=context.tender_id AND binding.source_lot_id=context.lot_key
    AND binding.lot_id=context.lot_id
);

UPDATE tender.context_backfill_runs
SET finished_at=now(),after_counts=jsonb_build_object(
  'pipeline_contexts_canonical',(SELECT count(*) FROM tender.pipeline_contexts
    WHERE context_integrity_status='CANONICAL'),
  'pipeline_contexts_repair_required',(SELECT count(*) FROM tender.pipeline_contexts
    WHERE context_integrity_status='REPAIR_REQUIRED'),
  'enrichment_context_bindings',(SELECT count(*) FROM tender.enrichment_context_bindings),
  'external_submission_enabled',false,
  'physical_deletes',0
)
WHERE release_id='20260825-authoritative-pipeline-enrichment-binding-127.1';

INSERT INTO app.schema_migrations(version,description)
VALUES('0127-authoritative-pipeline-enrichment-binding',
  'Bind only active exact company-lot pipeline contexts supported by current relevance or explicit lot selection')
ON CONFLICT(version) DO NOTHING;

COMMIT;
