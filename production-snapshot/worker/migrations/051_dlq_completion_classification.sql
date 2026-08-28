-- Audit-only completion classification. Queue rows and their history remain unchanged.
INSERT INTO tender.autopilot_dlq_classifications(
  queue_id,tender_id,lot_key,company_id,service_scope,original_created_at,
  release_version,worker_version,original_error_class,original_safe_description,
  reproduction_status,current_relevance,resolution,evidence,classified_by_release)
SELECT q.id,q.tender_id,coalesce(q.lot_key,''),q.company_id,q.service_scope,q.created_at,
  'generic-final-preflight-20260808-rc9',coalesce(q.worker_id,'unknown'),
  coalesce(q.safe_error_code,q.error_code,'UNCLASSIFIED'),coalesce(q.error_detail_safe,q.reason,'Keine sichere Fehlerbeschreibung'),
  CASE
    WHEN successor.id IS NOT NULL THEN 'NOT_REPRODUCIBLE'
    WHEN q.action_type='TEST_DOCUMENT_FETCH' AND coalesce(q.lot_key,'')='' THEN 'NOT_APPLICABLE'
    WHEN coalesce(q.safe_error_code,q.error_code)='NOT_ELIGIBLE' THEN 'NOT_APPLICABLE'
    WHEN current_context.id IS NULL THEN 'NOT_APPLICABLE'
    ELSE 'EXTERNAL_OR_ACTION_REQUIRED'
  END,
  CASE
    WHEN successor.id IS NOT NULL THEN 'CURRENT_CONTEXT_HAS_SUCCESSFUL_SUCCESSOR'
    WHEN t.data_class<>'PUBLIC_REAL' THEN 'HISTORICAL_TEST'
    WHEN t.offer_deadline IS NULL OR t.offer_deadline<=now() THEN 'HISTORICAL_OR_NO_DEADLINE'
    WHEN current_context.id IS NULL THEN 'NO_ACTIVE_CURRENT_CONTEXT'
    ELSE 'CURRENT_ACTIVE'
  END,
  CASE
    WHEN successor.id IS NOT NULL THEN 'RESOLVED_BY_CURRENT_RELEASE'
    WHEN q.action_type='TEST_DOCUMENT_FETCH' AND coalesce(q.lot_key,'')='' THEN 'INVALID_HISTORICAL_TEST_EVENT'
    WHEN coalesce(q.safe_error_code,q.error_code)='NOT_ELIGIBLE' THEN 'OBSOLETE_PIPELINE_VERSION'
    WHEN current_context.id IS NULL THEN 'OBSOLETE_SCHEMA'
    ELSE 'EXTERNAL_PORTAL_FAILURE'
  END,
  jsonb_build_object(
    'dlqId',q.id,'tenderId',q.tender_id,'tenderTitle',t.title,'lotKey',coalesce(q.lot_key,''),
    'companyId',q.company_id,'companyName',company.legal_name,'portalId',q.portal_id,
    'jobType',q.action_type,'errorClass',coalesce(q.safe_error_code,q.error_code),
    'errorCause',q.error_detail_safe,'createdAt',q.created_at,'lastRetry',coalesce(q.finished_at,q.heartbeat_at,q.claimed_at),
    'deadline',t.offer_deadline,'dataClass',t.data_class,'tenderStatus',t.status,
    'currentContext',current_context.id IS NOT NULL,'successfulSuccessor',successor.id IS NOT NULL,
    'successorId',successor.id,'successorStatus',successor.status,'safeToReprocess',false,
    'reasonNotReprocessed',CASE WHEN successor.id IS NOT NULL THEN 'Späterer Lauf war erfolgreich.' WHEN current_context.id IS NULL THEN 'Kein identischer kanonischer Current-Kontext.' ELSE 'Externer oder menschlicher Blocker.' END,
    'externalSubmission',false,'transmitted',false),
  'generic-final-preflight-20260808-rc9'
FROM tender.autopilot_queue q
JOIN tender.tenders t ON t.id=q.tender_id
LEFT JOIN tender.enterprise_company_links company ON company.company_id=q.company_id
LEFT JOIN tender.autopilot_dlq_classifications existing ON existing.queue_id=q.id
LEFT JOIN LATERAL(SELECT f.id FROM tender.current_final_preflight_contexts f WHERE f.tender_id=q.tender_id AND f.company_id=q.company_id AND f.lot_key=coalesce(q.lot_key,'') LIMIT 1)current_context ON true
LEFT JOIN LATERAL(SELECT s.id,s.status FROM tender.autopilot_queue s WHERE s.tender_id=q.tender_id AND s.company_id=q.company_id AND coalesce(s.lot_key,'')=coalesce(q.lot_key,'') AND s.created_at>q.created_at AND s.status IN('DONE','SUCCEEDED') ORDER BY s.created_at DESC LIMIT 1)successor ON true
WHERE q.status='DEAD_LETTER' AND existing.id IS NULL
ON CONFLICT(queue_id) DO NOTHING;

CREATE OR REPLACE VIEW tender.current_dlq_operational_summary AS
SELECT
  count(*) FILTER(WHERE resolution='CURRENTLY_REPRODUCIBLE')::int current_unresolved,
  count(*) FILTER(WHERE resolution='RESOLVED_BY_CURRENT_RELEASE')::int historical_resolved,
  count(*) FILTER(WHERE resolution IN('OBSOLETE_SCHEMA','OBSOLETE_PIPELINE_VERSION','INVALID_HISTORICAL_TEST_EVENT','DUPLICATE_EVENT'))::int historical_obsolete,
  count(*) FILTER(WHERE resolution='EXTERNAL_PORTAL_FAILURE')::int external_portal_failures,
  count(*) FILTER(WHERE resolution='MANUAL_REVIEW_REQUIRED')::int manual_review_required,
  count(*)::int historical_audit_total,max(classified_at) last_classified_at
FROM tender.autopilot_dlq_classifications;
