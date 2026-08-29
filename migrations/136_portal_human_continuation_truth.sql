BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:portal-human-continuation-truth:136',0));

WITH classification(reason_code,terminal_status) AS(VALUES
  ('REGISTERED_PORTAL_SCOPE_NOT_FOUND','ACCOUNT_SETUP_REQUIRED'),
  ('PORTALZUGANG_NICHT_KONFIGURIERT','ACCOUNT_SETUP_REQUIRED'),
  ('BENUTZERNAME_ODER_PASSWORT_FALSCH','ACCOUNT_SETUP_REQUIRED'),
  ('PASSWORT_ABGELAUFEN','ACCOUNT_SETUP_REQUIRED'),
  ('KONTO_GESPERRT','ACCOUNT_SETUP_REQUIRED'),
  ('SESSION_NICHT_FUER_DOWNLOAD_GUELTIG','ACCOUNT_SETUP_REQUIRED'),
  ('SESSION_COOKIE_FEHLT','ACCOUNT_SETUP_REQUIRED'),
  ('CREDENTIAL_VERSION_SUPERSEDED','ACCOUNT_SETUP_REQUIRED'),
  ('MFA_BESTÄTIGUNG_ERFORDERLICH','MANUAL_MFA_REQUIRED'),
  ('CAPTCHA_MANUELL_ERFORDERLICH','MANUAL_CAPTCHA_REQUIRED')
), corrected AS(
  UPDATE tender.autopilot_queue queue
  SET status='CANCELLED',current_step='HUMAN_ACTION_REQUIRED',progress_percent=100,
      terminal_at=coalesce(queue.terminal_at,queue.finished_at,now()),
      terminal_result=classification.terminal_status,
      result_summary=coalesce(queue.result_summary,'{}'::jsonb)||jsonb_build_object(
        'terminalClassificationVersion','portal-human-continuation-v1',
        'requiredAction',classification.terminal_status,
        'originalQueueStatus',queue.status,
        'originalCurrentStep',queue.current_step,
        'originalReasonCode',queue.error_code,
        'originalErrorDetailSafe',queue.error_detail_safe,
        'originalTerminalAt',queue.terminal_at,
        'originalTerminalResult',queue.terminal_result,
        'reclassifiedAt',now()
      ),
      error_code=NULL,safe_error_code=NULL,error_detail_safe=NULL
  FROM classification
  WHERE queue.status='DEAD_LETTER'
    AND queue.error_code=classification.reason_code
  RETURNING queue.id,classification.terminal_status
), evidence AS(
  SELECT count(*)::int affected_rows,
    encode(digest(coalesce(string_agg(id::text,',' ORDER BY id),''),'sha256'),'hex') row_fingerprint
  FROM corrected
), status_evidence AS(
  SELECT jsonb_object_agg(terminal_status,status_count) status_counts FROM (
    SELECT terminal_status,count(*)::int status_count FROM corrected GROUP BY terminal_status
  ) grouped
)
INSERT INTO tender.audit_events(action,metadata)
SELECT 'portal_human_continuation_status_reclassified',jsonb_build_object(
  'release','20260825-portal-human-continuation-truth-136.1',
  'affectedRows',affected_rows,'rowFingerprint',row_fingerprint,
  'statusCounts',status_counts,'fromStatus','DEAD_LETTER','toStatus','CANCELLED',
  'physicalDeletes',0,'externalWrite',false
)
FROM evidence CROSS JOIN status_evidence WHERE affected_rows>0;

INSERT INTO app.schema_migrations(version,description)
VALUES('0136-portal-human-continuation-truth',
  'Represent account, MFA and CAPTCHA prerequisites as executable human continuation states rather than technical dead letters')
ON CONFLICT(version) DO NOTHING;

COMMIT;
