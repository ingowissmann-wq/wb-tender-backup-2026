BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:pipeline-repair-continuation-truth:139',0));

WITH restored AS(
  UPDATE tender.autopilot_queue queue
  SET status=queue.result_summary->>'originalQueueStatus',
      current_step=queue.result_summary->>'originalCurrentStep',
      progress_percent=coalesce((queue.result_summary->>'originalProgressPercent')::int,0),
      error_code=queue.result_summary->>'originalErrorCode',
      safe_error_code=queue.result_summary->>'originalSafeErrorCode',
      error_detail_safe=queue.result_summary->>'originalErrorDetailSafe',
      finished_at=(queue.result_summary->>'originalFinishedAt')::timestamptz,
      terminal_at=(queue.result_summary->>'originalTerminalAt')::timestamptz,
      terminal_result=queue.result_summary->>'originalTerminalResult',
      result_summary=queue.result_summary
        -'terminalClassificationVersion'-'requiredAction'-'repairAction'
        -'originalQueueStatus'-'originalCurrentStep'-'originalProgressPercent'
        -'originalErrorCode'-'originalSafeErrorCode'-'originalErrorDetailSafe'
        -'originalFinishedAt'-'originalTerminalAt'-'originalTerminalResult'
        -'reclassifiedAt'-'externalWrite'
  WHERE queue.status='CANCELLED'
    AND queue.result_summary->>'terminalClassificationVersion'='pipeline-repair-continuation-v1'
    AND queue.result_summary->>'originalQueueStatus'='DEAD_LETTER'
  RETURNING id
), evidence AS(
  SELECT count(*)::int affected_rows,
    encode(digest(coalesce(string_agg(id::text,',' ORDER BY id),''),'sha256'),'hex') row_fingerprint
  FROM restored
)
INSERT INTO tender.audit_events(action,metadata)
SELECT 'pipeline_repair_continuation_status_rollback',jsonb_build_object(
  'release','20260825-pipeline-repair-continuation-truth-139.1',
  'affectedRows',affected_rows,'rowFingerprint',row_fingerprint,
  'physicalDeletes',0,'externalWrite',false,'externalSubmission',false
)
FROM evidence;

DELETE FROM app.schema_migrations WHERE version='0139-pipeline-repair-continuation-truth';

COMMIT;
