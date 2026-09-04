BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:pipeline-repair-continuation-truth:139',0));

WITH classification(reason_code,terminal_status,repair_action,current_step) AS(VALUES
  ('PORTAL_DER_AUSSCHREIBUNG_NICHT_ERMITTELT','DATA_CONTEXT_REPAIR_REQUIRED','DOCUMENT_OR_SUBMISSION_PORTAL_FOR_EXACT_COMPANY_TENDER_LOT_CONFIRM','REPAIR_ACTION_REQUIRED'),
  ('FEHLENDER_PORTALKONTEXT','DATA_CONTEXT_REPAIR_REQUIRED','DOCUMENT_OR_SUBMISSION_PORTAL_FOR_EXACT_COMPANY_TENDER_LOT_CONFIRM','REPAIR_ACTION_REQUIRED'),
  ('EXACT_ENRICHMENT_CONTEXT_REQUIRED','DATA_CONTEXT_REPAIR_REQUIRED','CANONICAL_LOT_ENRICHMENT_BINDING_REPAIR','REPAIR_ACTION_REQUIRED'),
  ('LOGIN_FORMULAR_GEAENDERT','ADAPTER_REPAIR_REQUIRED','PORTAL_LOGIN_ADAPTER_VALIDATE_AND_REPAIR','REPAIR_ACTION_REQUIRED'),
  ('LOGIN_REDIRECT_UNERWARTET','ADAPTER_REPAIR_REQUIRED','PORTAL_REDIRECT_PROFILE_VALIDATE_AND_REPAIR','REPAIR_ACTION_REQUIRED'),
  ('LOGIN_TEST_TIMEOUT','ADAPTER_REPAIR_REQUIRED','PORTAL_LOGIN_ADAPTER_VALIDATE_AND_REPAIR','REPAIR_ACTION_REQUIRED'),
  ('TECHNISCHER_CONNECTORFEHLER','ADAPTER_REPAIR_REQUIRED','PORTAL_ADAPTER_VALIDATE_AND_REPAIR','REPAIR_ACTION_REQUIRED'),
  ('DOKUMENTENLISTE_NICHT_ERMITTELT','ADAPTER_REPAIR_REQUIRED','PORTAL_DOCUMENT_LIST_ADAPTER_VALIDATE_AND_REPAIR','REPAIR_ACTION_REQUIRED'),
  ('DOWNLOADLINK_NICHT_AUFGELOEST','ADAPTER_REPAIR_REQUIRED','PORTAL_DOCUMENT_LINK_ADAPTER_VALIDATE_AND_REPAIR','REPAIR_ACTION_REQUIRED'),
  ('PORTAL_NICHT_VALIDIERT','ADAPTER_REPAIR_REQUIRED','PORTAL_ADAPTER_VALIDATE_AND_REPAIR','REPAIR_ACTION_REQUIRED'),
  ('KEIN_ADAPTER_VERFUEGBAR','UNSUPPORTED_PORTAL_REQUIRES_ADAPTER','PORTAL_ADAPTER_IMPLEMENT_AND_VALIDATE','REPAIR_ACTION_REQUIRED'),
  ('UNKNOWN_PORTAL_ADAPTER_REQUIRED','UNSUPPORTED_PORTAL_REQUIRES_ADAPTER','PORTAL_ADAPTER_IMPLEMENT_AND_VALIDATE','REPAIR_ACTION_REQUIRED'),
  ('PORTAL_NICHT_ERREICHBAR','EXTERNAL_PORTAL_UNAVAILABLE','RETRY_AFTER_VERIFIED_PORTAL_RECOVERY','REPAIR_ACTION_REQUIRED'),
  ('SESSION_RESTORE_FAILED','ACCOUNT_SETUP_REQUIRED','PORTAL_SESSION_REESTABLISH_FOR_EXACT_COMPANY','HUMAN_ACTION_REQUIRED'),
  ('EXTERNAL_DOCUMENT_REQUEST_REQUIRED','ACCOUNT_SETUP_REQUIRED','OPEN_PORTAL_AND_REQUEST_DOCUMENT_ACCESS','HUMAN_ACTION_REQUIRED')
), corrected AS(
  UPDATE tender.autopilot_queue queue
  SET status='CANCELLED',current_step=classification.current_step,progress_percent=100,
      finished_at=coalesce(queue.finished_at,now()),
      terminal_at=coalesce(queue.terminal_at,queue.finished_at,now()),
      terminal_result=classification.terminal_status,
      result_summary=coalesce(queue.result_summary,'{}'::jsonb)||jsonb_build_object(
        'terminalClassificationVersion','pipeline-repair-continuation-v1',
        'requiredAction',classification.terminal_status,
        'repairAction',classification.repair_action,
        'originalQueueStatus',queue.status,
        'originalCurrentStep',queue.current_step,
        'originalProgressPercent',queue.progress_percent,
        'originalErrorCode',queue.error_code,
        'originalSafeErrorCode',queue.safe_error_code,
        'originalErrorDetailSafe',queue.error_detail_safe,
        'originalFinishedAt',queue.finished_at,
        'originalTerminalAt',queue.terminal_at,
        'originalTerminalResult',queue.terminal_result,
        'reclassifiedAt',now(),'externalWrite',false
      ),
      error_code=NULL,safe_error_code=NULL,error_detail_safe=NULL
  FROM classification
  WHERE queue.status='DEAD_LETTER'
    AND coalesce(queue.safe_error_code,queue.error_code)=classification.reason_code
  RETURNING queue.id,classification.terminal_status,classification.reason_code
), evidence AS(
  SELECT count(*)::int affected_rows,
    encode(digest(coalesce(string_agg(id::text,',' ORDER BY id),''),'sha256'),'hex') row_fingerprint
  FROM corrected
), status_evidence AS(
  SELECT jsonb_object_agg(terminal_status,status_count) status_counts FROM(
    SELECT terminal_status,count(*)::int status_count FROM corrected GROUP BY terminal_status
  ) grouped
), reason_evidence AS(
  SELECT jsonb_object_agg(reason_code,reason_count) reason_counts FROM(
    SELECT reason_code,count(*)::int reason_count FROM corrected GROUP BY reason_code
  ) grouped
)
INSERT INTO tender.audit_events(action,metadata)
SELECT 'pipeline_repair_continuation_status_reclassified',jsonb_build_object(
  'release','20260825-pipeline-repair-continuation-truth-139.1',
  'affectedRows',affected_rows,'rowFingerprint',row_fingerprint,
  'statusCounts',status_counts,'reasonCounts',reason_counts,
  'fromStatus','DEAD_LETTER','toStatus','CANCELLED',
  'physicalDeletes',0,'externalWrite',false,'externalSubmission',false
)
FROM evidence CROSS JOIN status_evidence CROSS JOIN reason_evidence
WHERE affected_rows>0;

INSERT INTO app.schema_migrations(version,description)
VALUES('0139-pipeline-repair-continuation-truth',
  'Represent data-context, adapter, unsupported-portal and external-availability failures as executable repair continuations')
ON CONFLICT(version) DO NOTHING;

COMMIT;
