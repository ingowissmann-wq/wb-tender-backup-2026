BEGIN;

-- Compatibility rollback only. The canonical functions and false-only transmission
-- constraints deliberately remain in place while external submission is globally locked.
-- Historical applications accept PRODUCTION_VALIDATED, and the normalization trigger
-- keeps legacy writers migration-compatible without weakening safety.

UPDATE tender.portal_read_sessions
SET status='EXPIRED',revoked_at=coalesce(revoked_at,now())
WHERE tender.portal_session_effective_status(status,expires_at,revoked_at,verification_status)<>'ACTIVE'
  AND status='ACTIVE';

COMMIT;
