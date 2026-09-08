BEGIN;
SET LOCAL row_security=off;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM tenant_portal.offer_packages) THEN RAISE EXCEPTION 'offer_packages_not_empty_preserve_customer_data'; END IF; END $$;
DROP TABLE tenant_portal.offer_package_decisions;
DROP TABLE tenant_portal.offer_package_files;
DROP TABLE tenant_portal.offer_packages;
COMMIT;
