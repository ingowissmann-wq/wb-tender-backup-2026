BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:participation-terminal-truth:135',0));

WITH corrected AS(
  UPDATE tender.autopilot_queue
  SET status='CANCELLED',
      terminal_result='NOT_PARTICIPATION_ELIGIBLE',
      result_summary=coalesce(result_summary,'{}'::jsonb)||jsonb_build_object(
        'terminalClassificationVersion','participation-terminal-v1',
        'originalQueueStatus','DEAD_LETTER',
        'originalReasonCode','TENDER_NOT_PARTICIPATION_ELIGIBLE',
        'reclassifiedAt',now()
      ),
      error_code=NULL,safe_error_code=NULL,error_detail_safe=NULL
  WHERE status='DEAD_LETTER'
    AND current_step='PARTICIPATION_BLOCKED'
    AND error_code='TENDER_NOT_PARTICIPATION_ELIGIBLE'
    AND terminal_result IS NULL
  RETURNING id
), evidence AS(
  SELECT count(*)::int affected_rows,
    encode(digest(coalesce(string_agg(id::text,',' ORDER BY id),''),'sha256'),'hex') row_fingerprint
  FROM corrected
)
INSERT INTO tender.audit_events(action,metadata)
SELECT 'participation_terminal_status_reclassified',jsonb_build_object(
  'release','20260825-participation-terminal-truth-135.1',
  'affectedRows',affected_rows,'rowFingerprint',row_fingerprint,
  'fromStatus','DEAD_LETTER','toStatus','CANCELLED',
  'reasonCode','TENDER_NOT_PARTICIPATION_ELIGIBLE',
  'physicalDeletes',0,'externalWrite',false
)
FROM evidence WHERE affected_rows>0;

INSERT INTO app.schema_migrations(version,description)
VALUES('0135-participation-terminal-truth',
  'Classify exact non-participation outcomes as expected terminal cancellations instead of technical dead letters')
ON CONFLICT(version) DO NOTHING;

COMMIT;
