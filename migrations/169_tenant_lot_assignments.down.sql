BEGIN;
SET LOCAL row_security=off;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM tenant_portal.lot_assignment_versions) THEN RAISE EXCEPTION 'lot_assignments_not_empty_preserve_customer_data'; END IF;
END $$;
DROP TABLE tenant_portal.lot_assignment_versions;
DROP FUNCTION tenant_portal.validate_assignment_source();
DROP INDEX tenant_portal.company_profile_company_binding;
COMMIT;
