BEGIN;
SET LOCAL row_security=off;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM tenant_portal.management_decisions) THEN RAISE EXCEPTION 'management_decisions_not_empty_preserve_customer_data'; END IF;
END $$;
DROP TABLE tenant_portal.management_decisions;
COMMIT;
