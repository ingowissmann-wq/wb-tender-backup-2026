BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:obsolete-relevance-terminal-truth:140',0));

WITH corrected AS(
  UPDATE tender.autopilot_queue queue
  SET status='SUCCEEDED',current_step='SUPERSEDED_BY_CURRENT_RELEVANCE',progress_percent=100,
      finished_at=coalesce(queue.finished_at,now()),heartbeat_at=now(),
      result_summary=coalesce(queue.result_summary,'{}'::jsonb)||jsonb_build_object(
        'terminalClassificationVersion','obsolete-relevance-terminal-v1',
        'status','SUPERSEDED_BY_CURRENT_RELEVANCE',
        'reason','company/lot context was replaced by the current real notice classification',
        'originalQueueStatus',queue.status,
        'originalCurrentStep',queue.current_step,
        'originalProgressPercent',queue.progress_percent,
        'originalErrorCode',queue.error_code,
        'originalSafeErrorCode',queue.safe_error_code,
        'originalErrorDetailSafe',queue.error_detail_safe,
        'originalFinishedAt',queue.finished_at,
        'reclassifiedAt',now(),'externalWrite',false
      ),
      error_code=NULL,safe_error_code=NULL,error_detail_safe=NULL
  WHERE queue.status='DEAD_LETTER'
    AND coalesce(queue.safe_error_code,queue.error_code)='NOT_ELIGIBLE'
    AND coalesce(queue.result_summary->>'terminalClassificationVersion','')<>'obsolete-relevance-terminal-v1'
  RETURNING queue.id
), evidence AS(
  SELECT count(*)::int affected_rows,
    encode(digest(coalesce(string_agg(id::text,',' ORDER BY id),''),'sha256'),'hex') row_fingerprint
  FROM corrected
)
INSERT INTO tender.audit_events(action,metadata)
SELECT 'obsolete_relevance_terminal_status_reclassified',jsonb_build_object(
  'release','20260825-obsolete-relevance-terminal-truth-140.1',
  'affectedRows',affected_rows,'rowFingerprint',row_fingerprint,
  'fromStatus','DEAD_LETTER','toStatus','SUCCEEDED','reasonCode','NOT_ELIGIBLE',
  'physicalDeletes',0,'externalWrite',false,'externalSubmission',false
)
FROM evidence WHERE affected_rows>0;

INSERT INTO app.schema_migrations(version,description)
VALUES('0140-obsolete-relevance-terminal-truth',
  'Represent legacy NOT_ELIGIBLE pipeline outcomes as superseded relevance success')
ON CONFLICT(version) DO NOTHING;

COMMIT;
