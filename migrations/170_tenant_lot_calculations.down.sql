BEGIN;
SET LOCAL row_security=off;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM tenant_portal.lot_calculation_versions) THEN RAISE EXCEPTION 'lot_calculations_not_empty_preserve_customer_data'; END IF;
END $$;
DROP TABLE tenant_portal.lot_calculation_files;
DROP TABLE tenant_portal.lot_calculation_versions;
DROP INDEX tenant_portal.lot_assignment_tenant_binding;
COMMIT;
