BEGIN;

-- Data-preserving compatibility rollback: stop only open RC20 deadline polls.
-- Historical inbound evidence, exact scope guards and the expanded enum remain
-- in place so an older application cannot weaken or invalidate audit truth.
UPDATE tender.submission_reconciliation_jobs
SET status='CANCELLED',lease_owner=NULL,lease_expires_at=NULL,updated_at=now(),
    last_error_class='RC20_COMPATIBILITY_ROLLBACK',
    last_error_safe='Lesende Fristprüfung durch kompatiblen Anwendungsrollback beendet.'
WHERE job_kind='DEADLINE_POLL' AND status IN('QUEUED','RUNNING','RETRY_WAIT');

DROP INDEX IF EXISTS tender.submission_reconciliation_expired_lease;

COMMIT;
