BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

INSERT INTO tender.context_backfill_runs(release_id,before_counts,external_submission_enabled)
VALUES('20260825-canonical-lot-context-continuity-123.1',jsonb_build_object(
  'current_lifecycles_without_canonical_lot',(
    SELECT count(*) FROM tender.tender_lot_lifecycles lifecycle
    LEFT JOIN tender.lots lot ON lot.tender_id=lifecycle.tender_id AND lot.external_id=lifecycle.lot_key
    WHERE lifecycle.is_current AND lifecycle.lot_key IS NOT NULL AND btrim(lifecycle.lot_key)<>'' AND lot.id IS NULL
  )
),false)
ON CONFLICT(release_id) DO NOTHING;

CREATE OR REPLACE FUNCTION tender.materialize_canonical_lot_from_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, tender
AS $$
BEGIN
  IF NEW.is_current AND NEW.lot_key IS NOT NULL AND btrim(NEW.lot_key)<>'' THEN
    INSERT INTO tender.lots(tender_id,external_id,title,deadline,source_reference_id)
    SELECT NEW.tender_id,NEW.lot_key,NEW.lot_key,NEW.offer_deadline,reference.id
    FROM (SELECT 1) singleton
    LEFT JOIN LATERAL(
      SELECT source.id FROM tender.source_references source
      WHERE source.tender_id=NEW.tender_id
      ORDER BY source.retrieved_at DESC,source.id DESC LIMIT 1
    ) reference ON true
    ON CONFLICT(tender_id,external_id) WHERE external_id IS NOT NULL DO UPDATE
    SET deadline=coalesce(excluded.deadline,tender.lots.deadline),
        source_reference_id=coalesce(tender.lots.source_reference_id,excluded.source_reference_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS canonical_lot_context_continuity ON tender.tender_lot_lifecycles;
CREATE TRIGGER canonical_lot_context_continuity
AFTER INSERT OR UPDATE OF lot_key,offer_deadline,is_current
ON tender.tender_lot_lifecycles
FOR EACH ROW EXECUTE FUNCTION tender.materialize_canonical_lot_from_lifecycle();

INSERT INTO tender.lots(tender_id,external_id,title,deadline,source_reference_id)
SELECT lifecycle.tender_id,lifecycle.lot_key,lifecycle.lot_key,lifecycle.offer_deadline,reference.id
FROM tender.tender_lot_lifecycles lifecycle
LEFT JOIN LATERAL(
  SELECT source.id FROM tender.source_references source
  WHERE source.tender_id=lifecycle.tender_id
  ORDER BY source.retrieved_at DESC,source.id DESC LIMIT 1
) reference ON true
WHERE lifecycle.is_current AND lifecycle.lot_key IS NOT NULL AND btrim(lifecycle.lot_key)<>''
ON CONFLICT(tender_id,external_id) WHERE external_id IS NOT NULL DO UPDATE
SET deadline=coalesce(excluded.deadline,tender.lots.deadline),
    source_reference_id=coalesce(tender.lots.source_reference_id,excluded.source_reference_id);

-- The two controlled internal acceptance fixtures carry an explicit immutable
-- lot key in their manifest and queue contract. They are not external tenders.
INSERT INTO tender.lots(tender_id,external_id,title,deadline)
SELECT fixture.tender_id,'LOT-ACCEPTANCE-001',tender.title,tender.offer_deadline
FROM tender.internal_acceptance_fixtures fixture
JOIN tender.tenders tender ON tender.id=fixture.tender_id
WHERE tender.data_class='INTERNAL_ACCEPTANCE_FIXTURE'
ON CONFLICT(tender_id,external_id) WHERE external_id IS NOT NULL DO UPDATE
SET title=excluded.title,deadline=coalesce(excluded.deadline,tender.lots.deadline);

INSERT INTO tender.tender_lot_lifecycles(tender_id,lot_key,lifecycle_status,
  participation_status,offer_deadline,deadline_quality,is_current)
SELECT fixture.tender_id,'LOT-ACCEPTANCE-001','ACTIVE','ELIGIBLE',tender.offer_deadline,'EXACT',true
FROM tender.internal_acceptance_fixtures fixture
JOIN tender.tenders tender ON tender.id=fixture.tender_id
WHERE tender.data_class='INTERNAL_ACCEPTANCE_FIXTURE' AND tender.offer_deadline IS NOT NULL
  AND tender.offer_deadline>now()
ON CONFLICT(tender_id,lot_key) DO UPDATE
SET lifecycle_status='ACTIVE',participation_status='ELIGIBLE',participation_block_reason=NULL,
    offer_deadline=excluded.offer_deadline,deadline_quality='EXACT',is_current=true,updated_at=now();

WITH unambiguous_user_choice AS (
  SELECT selection.tenant_id,selection.company_id,selection.tender_id,min(selection.lot_key) source_lot_id,
    (array_agg(selection.user_id ORDER BY selection.updated_at DESC,selection.user_id DESC))[1] selected_by
  FROM tender.user_lot_selections selection
  GROUP BY selection.tenant_id,selection.company_id,selection.tender_id
  HAVING count(DISTINCT selection.lot_key)=1
), unambiguous_company_scope AS (
  SELECT choice.tenant_id,choice.company_id,choice.tender_id,choice.source_lot_id,choice.selected_by,
    min(scope.canonical_service) canonical_service
  FROM unambiguous_user_choice choice
  JOIN tender.enterprise_company_links company
    ON company.company_id=choice.company_id AND company.active
  JOIN tender.configuration_scopes scope
    ON scope.tenant_id=choice.tenant_id AND scope.company_id=choice.company_id
    AND scope.profile_id=company.tender_profile_id
  GROUP BY choice.tenant_id,choice.company_id,choice.tender_id,choice.source_lot_id,choice.selected_by
  HAVING count(*)=1
), canonical_context AS (
  SELECT choice.*,lot.id lot_id,version.id tender_version_id,
    lifecycle.deadline_evidence_id
  FROM unambiguous_company_scope choice
  JOIN tender.lots lot ON lot.tender_id=choice.tender_id AND lot.external_id=choice.source_lot_id
  JOIN tender.tender_lot_lifecycles lifecycle ON lifecycle.tender_id=choice.tender_id
    AND lifecycle.lot_key=choice.source_lot_id AND lifecycle.is_current
    AND lifecycle.deadline_evidence_id IS NOT NULL
  JOIN LATERAL(SELECT candidate.id FROM tender.tender_versions candidate
    WHERE candidate.tender_id=choice.tender_id ORDER BY candidate.version DESC LIMIT 1)version ON true
)
INSERT INTO tender.tender_lot_selections(tenant_id,company_id,tender_id,tender_version_id,lot_id,source_lot_id,
  canonical_service,deadline_evidence_id,selection_source,selected_by)
SELECT tenant_id,company_id,tender_id,tender_version_id,lot_id,source_lot_id,canonical_service,
  deadline_evidence_id,'EXPLICIT_SELECTION',selected_by
FROM canonical_context
ON CONFLICT(tenant_id,company_id,tender_id) DO NOTHING;

INSERT INTO tender.enrichment_context_bindings(enrichment_version_id,tenant_id,company_id,tender_id,
  tender_version_id,lot_id,source_lot_id,canonical_service,source_manifest_sha256)
SELECT enrichment.id,selection.tenant_id,selection.company_id,selection.tender_id,selection.tender_version_id,
  selection.lot_id,selection.source_lot_id,selection.canonical_service,enrichment.payload_sha256
FROM tender.tender_lot_selections selection
JOIN LATERAL(SELECT candidate.id,candidate.payload_sha256 FROM tender.enrichment_versions candidate
  WHERE candidate.tender_id=selection.tender_id AND candidate.historical=false
    AND candidate.payload_sha256 ~ '^[0-9a-f]{64}$'
  ORDER BY candidate.version DESC LIMIT 1) enrichment ON true
ON CONFLICT DO NOTHING;

UPDATE tender.context_backfill_runs
SET finished_at=now(),after_counts=jsonb_build_object(
  'current_lifecycles_without_canonical_lot',(
    SELECT count(*) FROM tender.tender_lot_lifecycles lifecycle
    LEFT JOIN tender.lots lot ON lot.tender_id=lifecycle.tender_id AND lot.external_id=lifecycle.lot_key
    WHERE lifecycle.is_current AND lifecycle.lot_key IS NOT NULL AND btrim(lifecycle.lot_key)<>'' AND lot.id IS NULL
  ),
  'canonical_lots_total',(SELECT count(*) FROM tender.lots),
  'canonical_lot_selections',(SELECT count(*) FROM tender.tender_lot_selections),
  'enrichment_context_bindings',(SELECT count(*) FROM tender.enrichment_context_bindings),
  'external_submission_enabled',false,
  'physical_deletes',0
)
WHERE release_id='20260825-canonical-lot-context-continuity-123.1';

INSERT INTO app.schema_migrations(version,description)
VALUES(
  '0123-canonical-lot-context-continuity',
  'Materialize canonical lots continuously and bind only unambiguous explicit lot selections to current enrichment context'
)
ON CONFLICT(version) DO NOTHING;

COMMIT;
