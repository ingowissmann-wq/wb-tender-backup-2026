BEGIN;
SET LOCAL row_security=off;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM tenant_portal.company_profile_versions) THEN RAISE EXCEPTION 'company_profiles_not_empty_preserve_customer_data'; END IF;
END $$;
DROP TABLE tenant_portal.company_profile_versions;
COMMIT;
