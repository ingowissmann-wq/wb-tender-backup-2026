-- Data-preserving rollback: invalidate usable releases, retain the audit trail and tables.
UPDATE tender.binding_action_releases
SET status='INVALIDATED'
WHERE status IN('REQUESTED','APPROVED');
-- The external submission lock and every transmitted=false constraint remain unchanged.
