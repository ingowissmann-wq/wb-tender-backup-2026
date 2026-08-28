BEGIN;

UPDATE saas.iam_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE revoked_at IS NULL;
DELETE FROM saas.iam_login_states;

-- Identity bindings are deliberately retained for a reversible application-first
-- rollback. Drop the three tables only during a later, separately approved data
-- retirement after retention and audit requirements have been satisfied.

COMMIT;

