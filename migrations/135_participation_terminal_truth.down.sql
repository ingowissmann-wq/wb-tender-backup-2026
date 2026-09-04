BEGIN;

UPDATE tender.autopilot_queue
SET status='DEAD_LETTER',terminal_result=NULL,
    error_code='TENDER_NOT_PARTICIPATION_ELIGIBLE',
    safe_error_code='TENDER_NOT_PARTICIPATION_ELIGIBLE',
    error_detail_safe='Diese Bekanntmachung ist nicht für Teilnahmeaktionen freigegeben.',
    result_summary=(coalesce(result_summary,'{}'::jsonb)
      -'terminalClassificationVersion'-'originalQueueStatus'-'originalReasonCode'-'reclassifiedAt')
WHERE status='CANCELLED'
  AND current_step='PARTICIPATION_BLOCKED'
  AND terminal_result='NOT_PARTICIPATION_ELIGIBLE'
  AND result_summary->>'terminalClassificationVersion'='participation-terminal-v1'
  AND result_summary->>'originalQueueStatus'='DEAD_LETTER';

DELETE FROM app.schema_migrations WHERE version='0135-participation-terminal-truth';

COMMIT;
