BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:obsolete-relevance-terminal-truth:140',0));

WITH restored AS(
  UPDATE tender.autopilot_queue queue
  SET status=queue.result_summary->>'originalQueueStatus',
      current_step=queue.result_summary->>'originalCurrentStep',
      progress_percent=coalesce((queue.result_summary->>'originalProgressPercent')::int,0),
      error_code=queue.result_summary->>'originalErrorCode',
      safe_error_code=queue.result_summary->>'originalSafeErrorCode',
      error_detail_safe=queue.result_summary->>'originalErrorDetailSafe',
      finished_at=(queue.result_summary->>'originalFinishedAt')::timestamptz,
      result_summary=queue.result_summary
        - 'terminalClassificationVersion' - 'status' - 'reason'
        - 'originalQueueStatus' - 'originalCurrentStep' - 'originalProgressPercent'
        - 'originalErrorCode' - 'originalSafeErrorCode' - 'originalErrorDetailSafe'
        - 'originalFinishedAt' - 'reclassifiedAt' - 'externalWrite'
  WHERE queue.status='SUCCEEDED'
    AND queue.current_step='SUPERSEDED_BY_CURRENT_RELEVANCE'
    AND queue.result_summary->>'terminalClassificationVersion'='obsolete-relevance-terminal-v1'
  RETURNING queue.id
), evidence AS(
  SELECT count(*)::int affected_rows,
    encode(digest(coalesce(string_agg(id::text,',' ORDER BY id),''),'sha256'),'hex') row_fingerprint
  FROM restored
)
INSERT INTO tender.audit_events(action,metadata)
SELECT 'obsolete_relevance_terminal_status_rollback',jsonb_build_object(
  'release','20260825-obsolete-relevance-terminal-truth-140.1',
  'affectedRows',affected_rows,'rowFingerprint',row_fingerprint,
  'physicalDeletes',0,'externalWrite',false,'externalSubmission',false
)
FROM evidence WHERE affected_rows>0;

DELETE FROM app.schema_migrations WHERE version='0140-obsolete-relevance-terminal-truth';

COMMIT;
