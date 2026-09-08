BEGIN;
SET LOCAL row_security=off;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM tenant_portal.credential_vault) THEN RAISE EXCEPTION 'credential_vault_not_empty_preserve_customer_data'; END IF;
END $$;
DROP TABLE tenant_portal.credential_vault;
DROP FUNCTION tenant_portal.guard_credential_binding();
COMMIT;
