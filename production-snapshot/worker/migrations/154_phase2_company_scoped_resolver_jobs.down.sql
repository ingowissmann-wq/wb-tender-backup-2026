BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:migration:154-phase2-company-scoped-resolver-down',0));

UPDATE tender.autopilot_queue SET status='CANCELLED',current_step='ROLLBACK_PHASE2_154',finished_at=now(),heartbeat_at=now()
WHERE action_type='RESOLVE_NOTICE_PORTALS' AND company_id IS NOT NULL
  AND status IN('QUEUED','RETRY_WAIT','BLOCKED') AND started_at IS NULL;
COMMIT;

-- Restore migration 153's trigger definition without deleting any queue or business rows.
\ir 153_phase2_authoritative_portal_jobs.sql
BEGIN;
INSERT INTO tender.audit_events(action,metadata) VALUES('PHASE2_COMPANY_SCOPED_RESOLVER_GUARD_ROLLED_BACK',jsonb_build_object(
  'release','20260826-phase2-company-scoped-resolver-154.1','businessRowsDeleted',false,'externalSubmission',false));
INSERT INTO app.schema_migrations(version,description) VALUES('0154-phase2-company-scoped-resolver-jobs-down',
  'Soft-cancel unstarted company resolver jobs and restore the migration 153 guard') ON CONFLICT(version) DO NOTHING;
COMMIT;
