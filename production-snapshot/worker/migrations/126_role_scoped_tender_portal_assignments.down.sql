BEGIN;

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';

DROP VIEW IF EXISTS tender.current_tender_company_portal_role_scopes;

-- Expand-only rollback: retain portal_role and the role-aware unique index so
-- independent document/submission evidence is never collapsed or discarded.
DELETE FROM app.schema_migrations WHERE version='0126-role-scoped-tender-portal-assignments';

COMMIT;
