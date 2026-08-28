\set ON_ERROR_STOP on

BEGIN READ ONLY;

DO $$
DECLARE invalid integer; affected integer;
BEGIN
  SELECT count(*) INTO invalid FROM tender.autopilot_queue
  WHERE result_summary->>'terminalClassificationVersion'='pipeline-repair-continuation-v1'
    AND (status<>'CANCELLED' OR current_step NOT IN('REPAIR_ACTION_REQUIRED','HUMAN_ACTION_REQUIRED')
      OR terminal_result NOT IN('DATA_CONTEXT_REPAIR_REQUIRED','ADAPTER_REPAIR_REQUIRED',
        'UNSUPPORTED_PORTAL_REQUIRES_ADAPTER','EXTERNAL_PORTAL_UNAVAILABLE','ACCOUNT_SETUP_REQUIRED')
      OR result_summary->>'repairAction' IS NULL
      OR coalesce((result_summary->>'externalWrite')::boolean,true));
  SELECT coalesce(max((metadata->>'affectedRows')::int),0) INTO affected
  FROM tender.audit_events WHERE action='pipeline_repair_continuation_status_reclassified';
  IF invalid<>0 THEN RAISE EXCEPTION 'invalid repair continuation rows: %',invalid; END IF;
  IF affected<1 THEN RAISE EXCEPTION 'expected historical repair continuation evidence'; END IF;
END $$;

SELECT terminal_result,count(*) FROM tender.autopilot_queue
WHERE result_summary->>'terminalClassificationVersion'='pipeline-repair-continuation-v1'
GROUP BY terminal_result ORDER BY terminal_result;

ROLLBACK;
