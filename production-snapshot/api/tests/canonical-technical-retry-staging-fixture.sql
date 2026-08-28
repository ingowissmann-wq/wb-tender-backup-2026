\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS tender.canonical_technical_retry_138_fixture_restore(
  queue_id uuid PRIMARY KEY,
  original_created_at timestamptz NOT NULL
);

TRUNCATE tender.canonical_technical_retry_138_fixture_restore;

WITH latest_error AS MATERIALIZED(
  SELECT DISTINCT ON(queue.tender_id,queue.company_id,queue.lot_key,queue.action_type)
    queue.*,coalesce(queue.safe_error_code,queue.error_code) source_error_code
  FROM tender.autopilot_queue queue
  WHERE queue.status IN('DEAD_LETTER','FAILED')
    AND queue.company_id IS NOT NULL AND queue.lot_key IS NOT NULL
    AND coalesce(queue.safe_error_code,queue.error_code) IN(
      'TECHNISCHER_CONNECTORFEHLER','PORTAL_DER_AUSSCHREIBUNG_NICHT_ERMITTELT',
      'DOWNLOADLINK_NICHT_AUFGELOEST','DOKUMENTENLISTE_NICHT_ERMITTELT')
  ORDER BY queue.tender_id,queue.company_id,queue.lot_key,queue.action_type,
    queue.created_at DESC,queue.id DESC
), unresolved AS MATERIALIZED(
  SELECT error.* FROM latest_error error
  WHERE NOT EXISTS(
    SELECT 1 FROM tender.autopilot_queue later
    WHERE later.created_at>error.created_at
      AND later.tender_id=error.tender_id AND later.company_id=error.company_id
      AND later.lot_key=error.lot_key AND later.action_type=error.action_type
      AND later.status IN('SUCCEEDED','DONE','CANCELLED'))
), source AS MATERIALIZED(
  SELECT DISTINCT ON(error.tender_id,error.company_id,error.lot_key) error.*
  FROM unresolved error
  ORDER BY error.tender_id,error.company_id,error.lot_key,error.created_at DESC,error.id DESC
), eligible AS MATERIALIZED(
  SELECT source.* FROM source
  JOIN tender.tenders tender ON tender.id=source.tender_id
    AND tender.data_class='PUBLIC_REAL' AND tender.source_lifecycle_status='ACTIVE'
    AND tender.wb_relevance_status='RELEVANT' AND tender.participation_status='ELIGIBLE'
    AND tender.classification_confidence='HIGH'
  JOIN tender.enterprise_company_links company ON company.company_id=source.company_id AND company.active
  JOIN tender.lots lot ON lot.tender_id=source.tender_id AND lot.external_id=source.lot_key
  JOIN tender.tender_lot_lifecycles lifecycle ON lifecycle.tender_id=source.tender_id
    AND lifecycle.lot_key=source.lot_key AND lifecycle.is_current
    AND lifecycle.lifecycle_status='ACTIVE' AND lifecycle.participation_status='ELIGIBLE'
    AND lifecycle.deadline_evidence_id IS NOT NULL AND lifecycle.offer_deadline>now()
  JOIN LATERAL(SELECT id FROM tender.enrichment_versions enrichment
    WHERE enrichment.tender_id=source.tender_id AND enrichment.historical=false
    ORDER BY enrichment.version DESC LIMIT 1) current_enrichment ON true
  JOIN tender.current_service_relevance relevance ON relevance.tender_id=source.tender_id
    AND relevance.company_id=source.company_id AND relevance.lot_key=source.lot_key
    AND relevance.relevance_status='RELEVANT' AND relevance.service_scope_gate='PASSED'
    AND relevance.recommendation='FULL_PIPELINE_ALLOWED'
  JOIN tender.current_registered_tender_company_portals registered
    ON registered.tender_id=source.tender_id AND registered.company_id=source.company_id
  JOIN LATERAL(SELECT max(configuration_version_no) version
    FROM tender.region_evaluations region WHERE region.tender_id=source.tender_id
      AND region.company_id=source.company_id) configuration ON configuration.version IS NOT NULL
  JOIN tender.pipeline_contexts context ON context.tender_id=source.tender_id
    AND context.company_id=source.company_id AND context.lot_id=lot.id
    AND context.enrichment_version_id=current_enrichment.id
    AND context.context_integrity_status='CANONICAL'
), blockers AS(
  SELECT later.id queue_id,later.created_at original_created_at,
    min(eligible.created_at)-interval '1 second' fixture_created_at
  FROM eligible
  JOIN tender.autopilot_queue later ON later.created_at>eligible.created_at
    AND later.tender_id=eligible.tender_id AND later.company_id=eligible.company_id
    AND later.lot_key=eligible.lot_key AND later.action_type='RUN_FULL_PIPELINE'
    AND later.status NOT IN('DEAD_LETTER','FAILED')
  GROUP BY later.id,later.created_at
), stored AS(
  INSERT INTO tender.canonical_technical_retry_138_fixture_restore(queue_id,original_created_at)
  SELECT queue_id,original_created_at FROM blockers
  ON CONFLICT(queue_id) DO UPDATE SET original_created_at=excluded.original_created_at
  RETURNING queue_id
)
UPDATE tender.autopilot_queue queue
SET created_at=blockers.fixture_created_at
FROM blockers JOIN stored ON stored.queue_id=blockers.queue_id
WHERE queue.id=blockers.queue_id;

COMMIT;

SELECT count(*) shifted_later_jobs
FROM tender.canonical_technical_retry_138_fixture_restore;
