-- Data-preserving rollback: stop claims and remove only the read projection.
UPDATE tender.submission_reconciliation_jobs
SET status='CANCELLED',lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
WHERE status IN('QUEUED','RUNNING','RETRY_WAIT');
DROP VIEW IF EXISTS tender.current_submission_feedback;
-- Audit/event/manifest tables and the immutability trigger intentionally remain.
