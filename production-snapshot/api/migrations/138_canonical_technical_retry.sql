BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:canonical-technical-retry:138',0));

WITH latest_error AS MATERIALIZED(
  SELECT DISTINCT ON(queue.tender_id,queue.company_id,queue.lot_key,queue.action_type)
    queue.*,coalesce(queue.safe_error_code,queue.error_code) source_error_code
  FROM tender.autopilot_queue queue
  WHERE queue.status IN('DEAD_LETTER','FAILED')
    AND queue.company_id IS NOT NULL
    AND queue.lot_key IS NOT NULL
    AND coalesce(queue.safe_error_code,queue.error_code) IN(
      'TECHNISCHER_CONNECTORFEHLER',
      'PORTAL_DER_AUSSCHREIBUNG_NICHT_ERMITTELT',
      'DOWNLOADLINK_NICHT_AUFGELOEST',
      'DOKUMENTENLISTE_NICHT_ERMITTELT'
    )
  ORDER BY queue.tender_id,queue.company_id,queue.lot_key,queue.action_type,
    queue.created_at DESC,queue.id DESC
), unresolved_error AS MATERIALIZED(
  SELECT error.* FROM latest_error error
  WHERE error.source_error_code IN(
      'TECHNISCHER_CONNECTORFEHLER',
      'PORTAL_DER_AUSSCHREIBUNG_NICHT_ERMITTELT',
      'DOWNLOADLINK_NICHT_AUFGELOEST',
      'DOKUMENTENLISTE_NICHT_ERMITTELT'
    )
    AND NOT EXISTS(
      SELECT 1 FROM tender.autopilot_queue later
      WHERE later.created_at>error.created_at
        AND later.tender_id=error.tender_id
        AND later.company_id=error.company_id
        AND later.lot_key=error.lot_key
        AND later.action_type=error.action_type
        AND later.status IN('SUCCEEDED','DONE','CANCELLED')
        AND NOT (later.status='CANCELLED'
          AND later.terminal_result='MIGRATION_ROLLBACK_BEFORE_EXECUTION')
    )
), source_context AS MATERIALIZED(
  SELECT DISTINCT ON(error.tender_id,error.company_id,error.lot_key) error.*
  FROM unresolved_error error
  ORDER BY error.tender_id,error.company_id,error.lot_key,error.created_at DESC,error.id DESC
), authoritative_context AS MATERIALIZED(
  SELECT source.*,lot.id canonical_lot_id,
    current_tender_version.id current_tender_version_id,
    current_enrichment.id current_enrichment_version_id,
    relevance.evaluation_version current_assessment_version,
    relevance.service_line current_service_scope,
    registered.portal_id current_portal_id,
    registered.credential_id current_credential_id,
    registry.adapter_id current_adapter_id,
    registry.adapter_version current_adapter_version,
    configuration.configuration_version_no::text current_configuration_version,
    coalesce(tender.notice_number,tender.external_id) current_notice_id
  FROM source_context source
  JOIN tender.tenders tender ON tender.id=source.tender_id
    AND tender.data_class='PUBLIC_REAL'
    AND tender.source_lifecycle_status='ACTIVE'
    AND tender.wb_relevance_status='RELEVANT'
    AND tender.participation_status='ELIGIBLE'
    AND tender.classification_confidence='HIGH'
  JOIN tender.enterprise_company_links company
    ON company.company_id=source.company_id AND company.active
  JOIN tender.lots lot
    ON lot.tender_id=source.tender_id AND lot.external_id=source.lot_key
  JOIN tender.tender_lot_lifecycles lifecycle
    ON lifecycle.tender_id=source.tender_id
    AND lifecycle.lot_key=source.lot_key
    AND lifecycle.is_current
    AND lifecycle.lifecycle_status='ACTIVE'
    AND lifecycle.participation_status='ELIGIBLE'
    AND lifecycle.deadline_evidence_id IS NOT NULL
    AND lifecycle.offer_deadline>now()
  JOIN LATERAL(
    SELECT version.id FROM tender.tender_versions version
    WHERE version.tender_id=source.tender_id
    ORDER BY version.version DESC LIMIT 1
  ) current_tender_version ON true
  JOIN LATERAL(
    SELECT enrichment.id FROM tender.enrichment_versions enrichment
    WHERE enrichment.tender_id=source.tender_id AND enrichment.historical=false
    ORDER BY enrichment.version DESC LIMIT 1
  ) current_enrichment ON true
  JOIN tender.current_service_relevance relevance
    ON relevance.tender_id=source.tender_id
    AND relevance.company_id=source.company_id
    AND relevance.lot_key=source.lot_key
    AND relevance.relevance_status='RELEVANT'
    AND relevance.service_scope_gate='PASSED'
    AND relevance.recommendation='FULL_PIPELINE_ALLOWED'
  JOIN tender.current_registered_tender_company_portals registered
    ON registered.tender_id=source.tender_id
    AND registered.company_id=source.company_id
  JOIN tender.portal_registry registry ON registry.id=registered.portal_id
  JOIN LATERAL(
    SELECT max(region.configuration_version_no) configuration_version_no
    FROM tender.region_evaluations region
    WHERE region.tender_id=source.tender_id
      AND region.company_id=source.company_id
  ) configuration ON configuration.configuration_version_no IS NOT NULL
  JOIN tender.pipeline_contexts pipeline_context
    ON pipeline_context.tender_id=source.tender_id
    AND pipeline_context.company_id=source.company_id
    AND pipeline_context.lot_id=lot.id
    AND pipeline_context.enrichment_version_id=current_enrichment.id
    AND pipeline_context.context_integrity_status='CANONICAL'
  WHERE NOT EXISTS(
    SELECT 1 FROM tender.autopilot_queue later
    WHERE later.created_at>source.created_at
      AND later.tender_id=source.tender_id
      AND later.company_id=source.company_id
      AND later.lot_key=source.lot_key
      AND later.action_type='RUN_FULL_PIPELINE'
      AND later.status NOT IN('DEAD_LETTER','FAILED')
      AND NOT (later.status='CANCELLED'
        AND later.terminal_result='MIGRATION_ROLLBACK_BEFORE_EXECUTION')
  )
), reactivated AS(
  UPDATE tender.autopilot_queue queue
  SET status='QUEUED',attempt=0,next_attempt_at=now(),claimed_at=NULL,
      finished_at=NULL,started_at=NULL,heartbeat_at=NULL,worker_id=NULL,
      current_step='QUEUED',progress_percent=0,terminal_at=NULL,terminal_result=NULL,
      error_code=NULL,safe_error_code=NULL,error_detail_safe=NULL,
      blocking_reason=NULL,result_summary=NULL,
      calculation_status='DOCUMENT_FETCH_QUEUED',next_step='FETCH_DOCUMENTS'
  FROM authoritative_context context
  WHERE queue.reason='CANONICAL_TECHNICAL_RETRY_138'
    AND queue.tender_id=context.tender_id
    AND queue.company_id=context.company_id
    AND queue.lot_id=context.canonical_lot_id
    AND queue.status='CANCELLED'
    AND queue.terminal_result='MIGRATION_ROLLBACK_BEFORE_EXECUTION'
    AND queue.attempt=0
  RETURNING queue.id
), inserted AS(
  INSERT INTO tender.autopilot_queue(
    request_id,action_type,tender_id,tender_version_id,notice_id,lot_id,lot_key,
    company_id,service_scope,portal_id,credential_id,enrichment_version_id,
    assessment_version_id,configuration_version_id,adapter_id,adapter_version,
    idempotency_key,reason,status,current_step,calculation_status,next_step,
    max_attempts,created_by
  )
  SELECT gen_random_uuid(),'RUN_FULL_PIPELINE',context.tender_id,
    context.current_tender_version_id,context.current_notice_id,
    context.canonical_lot_id,context.lot_key,context.company_id,
    context.current_service_scope,context.current_portal_id,
    context.current_credential_id,context.current_enrichment_version_id,
    context.current_assessment_version,context.current_configuration_version,
    context.current_adapter_id,context.current_adapter_version,
    encode(digest(concat_ws(':','canonical-technical-retry-138',context.tender_id,
      context.company_id,context.canonical_lot_id,context.current_tender_version_id,
      context.current_enrichment_version_id,context.current_assessment_version,
      context.current_configuration_version),'sha256'),'hex'),
    'CANONICAL_TECHNICAL_RETRY_138','QUEUED','QUEUED',
    'DOCUMENT_FETCH_QUEUED','FETCH_DOCUMENTS',3,context.created_by
  FROM authoritative_context context
  WHERE NOT EXISTS(
    SELECT 1 FROM tender.autopilot_queue existing
    WHERE existing.reason='CANONICAL_TECHNICAL_RETRY_138'
      AND existing.tender_id=context.tender_id
      AND existing.company_id=context.company_id
      AND existing.lot_id=context.canonical_lot_id
  )
  RETURNING id
), changed AS(
  SELECT id,'REACTIVATED'::text operation FROM reactivated
  UNION ALL SELECT id,'INSERTED'::text operation FROM inserted
), evidence AS(
  SELECT count(*)::int affected_rows,
    count(*) FILTER(WHERE operation='INSERTED')::int inserted_rows,
    count(*) FILTER(WHERE operation='REACTIVATED')::int reactivated_rows,
    encode(digest(coalesce(string_agg(id::text,',' ORDER BY id),''),'sha256'),'hex') row_fingerprint
  FROM changed
), source_evidence AS(
  SELECT jsonb_object_agg(source_error_code,error_count) source_error_counts
  FROM (
    SELECT source_error_code,count(*)::int error_count
    FROM authoritative_context GROUP BY source_error_code
  ) grouped
)
INSERT INTO tender.audit_events(action,metadata)
SELECT 'canonical_technical_retry_scheduled',jsonb_build_object(
  'release','20260825-canonical-technical-retry-138.1',
  'affectedRows',affected_rows,'insertedRows',inserted_rows,
  'reactivatedRows',reactivated_rows,'rowFingerprint',row_fingerprint,
  'sourceErrorCounts',source_error_counts,'canonicalLotRequired',true,
  'currentTenderVersionRequired',true,'currentEnrichmentRequired',true,
  'currentRegisteredPortalCredentialRequired',true,
  'openEligibleLifecycleRequired',true,
  'externalWrite',false,'externalSubmission',false,'physicalDeletes',0
)
FROM evidence CROSS JOIN source_evidence WHERE affected_rows>0;

INSERT INTO app.schema_migrations(version,description)
VALUES('0138-canonical-technical-retry',
  'Schedule exact canonical replacement jobs for unresolved active connector and portal-resolution failures')
ON CONFLICT(version) DO NOTHING;

COMMIT;
