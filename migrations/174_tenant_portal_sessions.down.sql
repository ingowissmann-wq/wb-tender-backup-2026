BEGIN;
SET LOCAL row_security=off;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM tenant_portal.portal_sessions) THEN RAISE EXCEPTION 'portal_sessions_not_empty_preserve_customer_data'; END IF; END $$;
DROP TABLE tenant_portal.portal_sessions;
DROP FUNCTION tenant_portal.guard_session_binding();
DROP INDEX tenant_portal.credential_vault_session_binding;
COMMIT;
