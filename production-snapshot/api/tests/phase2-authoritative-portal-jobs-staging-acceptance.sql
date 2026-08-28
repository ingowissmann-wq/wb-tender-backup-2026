\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE candidate record; accepted uuid; denied boolean:=false;
BEGIN
  SELECT tender.id tender_id,version.id version_id,relevance.company_id INTO candidate
  FROM tender.tenders tender
  JOIN LATERAL(SELECT current_version.id FROM tender.tender_versions current_version
    WHERE current_version.tender_id=tender.id
    ORDER BY current_version.version DESC,current_version.created_at DESC,current_version.id DESC LIMIT 1) version ON true
  JOIN tender.current_service_relevance relevance ON relevance.tender_id=tender.id
    AND relevance.primary_company=true AND relevance.relevance_status IN('RELEVANT','REVIEW_REQUIRED')
  WHERE tender.data_class='PUBLIC_REAL' ORDER BY tender.id,relevance.company_id LIMIT 1;
  IF candidate.tender_id IS NULL THEN RAISE EXCEPTION 'real_restore_tender_context_missing'; END IF;

  INSERT INTO tender.autopilot_queue(tender_id,tender_version_id,company_id,reason,request_id,action_type,
    idempotency_key,status,current_step,max_attempts)
  VALUES(candidate.tender_id,candidate.version_id,candidate.company_id,'PHASE2_STAGING_ROLLBACK_ONLY',gen_random_uuid(),
    'RESOLVE_NOTICE_PORTALS',concat('phase2-staging:',candidate.tender_id,':',candidate.version_id,':',candidate.company_id),
    'QUEUED','PORTAL_EVIDENCE_QUEUED',1) RETURNING id INTO accepted;
  IF accepted IS NULL THEN RAISE EXCEPTION 'valid_resolution_job_was_not_accepted'; END IF;

  BEGIN
    INSERT INTO tender.autopilot_queue(tender_id,tender_version_id,company_id,reason,request_id,
      action_type,idempotency_key,status,current_step,max_attempts)
    SELECT candidate.tender_id,candidate.version_id,company.company_id,'PHASE2_INVALID_SCOPE',
      gen_random_uuid(),'RESOLVE_NOTICE_PORTALS',concat('phase2-invalid:',candidate.tender_id,':',company.company_id),
      'QUEUED','PORTAL_EVIDENCE_QUEUED',1
    FROM tender.enterprise_company_links company WHERE company.active
      AND company.company_id<>candidate.company_id ORDER BY company.legal_name LIMIT 1;
  EXCEPTION WHEN check_violation THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'wrong_company_resolution_job_was_not_denied'; END IF;

  IF EXISTS(SELECT 1 FROM tender.submission_contexts WHERE transmitted=true)
    OR EXISTS(SELECT 1 FROM tender.submission_receipts) THEN
    RAISE EXCEPTION 'submission_state_changed_or_was_not_hard_disabled';
  END IF;
END $$;

SELECT 'phase2_resolution_job_guard_staging_acceptance' result;
ROLLBACK;
