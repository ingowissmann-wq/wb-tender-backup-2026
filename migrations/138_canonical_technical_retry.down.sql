BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:canonical-technical-retry:138',0));

WITH cancelled AS(
  UPDATE tender.autopilot_queue
  SET status='CANCELLED',current_step='MIGRATION_ROLLBACK',
      finished_at=now(),terminal_at=now(),
      terminal_result='MIGRATION_ROLLBACK_BEFORE_EXECUTION',
      result_summary=coalesce(result_summary,'{}'::jsonb)||jsonb_build_object(
        'rollbackRelease','20260825-canonical-technical-retry-138.1',
        'externalWrite',false,'physicalDelete',false
      )
  WHERE reason='CANONICAL_TECHNICAL_RETRY_138'
    AND status IN('PENDING','QUEUED','RETRY')
    AND attempt=0 AND started_at IS NULL
  RETURNING id
), evidence AS(
  SELECT count(*)::int affected_rows,
    encode(digest(coalesce(string_agg(id::text,',' ORDER BY id),''),'sha256'),'hex') row_fingerprint
  FROM cancelled
)
INSERT INTO tender.audit_events(action,metadata)
SELECT 'canonical_technical_retry_rolled_back',jsonb_build_object(
  'release','20260825-canonical-technical-retry-138.1',
  'affectedRows',affected_rows,'rowFingerprint',row_fingerprint,
  'rollbackMode','SOFT_CANCEL_UNSTARTED_ONLY',
  'externalWrite',false,'externalSubmission',false,'physicalDeletes',0
)
FROM evidence;

DELETE FROM app.schema_migrations WHERE version='0138-canonical-technical-retry';

COMMIT;
