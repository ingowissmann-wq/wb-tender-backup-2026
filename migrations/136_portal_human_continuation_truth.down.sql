BEGIN;

UPDATE tender.autopilot_queue
SET status=result_summary->>'originalQueueStatus',
    current_step=result_summary->>'originalCurrentStep',
    error_code=result_summary->>'originalReasonCode',
    safe_error_code=result_summary->>'originalReasonCode',
    error_detail_safe=result_summary->>'originalErrorDetailSafe',
    terminal_at=(result_summary->>'originalTerminalAt')::timestamptz,
    terminal_result=result_summary->>'originalTerminalResult',
    result_summary=(result_summary-'terminalClassificationVersion'-'requiredAction'
      -'originalQueueStatus'-'originalCurrentStep'-'originalReasonCode'
      -'originalErrorDetailSafe'-'originalTerminalAt'-'originalTerminalResult'
      -'reclassifiedAt')
WHERE status='CANCELLED'
  AND current_step='HUMAN_ACTION_REQUIRED'
  AND result_summary->>'terminalClassificationVersion'='portal-human-continuation-v1';

DELETE FROM app.schema_migrations WHERE version='0136-portal-human-continuation-truth';

COMMIT;
