\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE candidate record; denied boolean:=false;
BEGIN
  SELECT tender.id tender_id,version.id version_id INTO candidate
  FROM tender.tenders tender
  JOIN LATERAL(SELECT current_version.id FROM tender.tender_versions current_version
    WHERE current_version.tender_id=tender.id ORDER BY current_version.version DESC,current_version.id DESC LIMIT 1) version ON true
  WHERE tender.data_class='PUBLIC_REAL' ORDER BY tender.id LIMIT 1;
  BEGIN
    INSERT INTO tender.autopilot_queue(tender_id,tender_version_id,reason,request_id,action_type,
      idempotency_key,status,current_step,max_attempts)
    VALUES(candidate.tender_id,candidate.version_id,'PHASE2_DOWN_STAGING',gen_random_uuid(),
      'RESOLVE_NOTICE_PORTALS',concat('phase2-down:',candidate.tender_id,':',candidate.version_id),
      'QUEUED','PORTAL_EVIDENCE_QUEUED',1);
  EXCEPTION WHEN check_violation THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'rollback_guard_accepted_resolution_job'; END IF;
  IF EXISTS(SELECT 1 FROM app.schema_migrations WHERE version='0153-phase2-authoritative-portal-jobs')
    THEN RAISE EXCEPTION 'rollback_marker_still_present'; END IF;
END $$;
SELECT 'phase2_resolution_job_guard_down_staging_acceptance' result;
ROLLBACK;
