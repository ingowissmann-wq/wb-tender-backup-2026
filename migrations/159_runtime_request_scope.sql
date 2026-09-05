BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';

DO $$
DECLARE item text;
BEGIN
  FOREACH item IN ARRAY ARRAY[
    'configuration_scopes',
    'configuration_versions',
    'region_profile_versions',
    'region_evaluations',
    'region_recalculation_jobs'
  ] LOOP
    CONTINUE WHEN to_regclass(format('tender.%I',item)) IS NULL;
    EXECUTE format('DROP POLICY IF EXISTS configuration_tenant_isolation ON tender.%I',item);
    EXECUTE format(
      'CREATE POLICY configuration_tenant_isolation ON tender.%1$I USING(tender.runtime_tenant_allowed(tenant_id)) WITH CHECK(tender.runtime_tenant_allowed(tenant_id))',
      item
    );
  END LOOP;
END $$;

DO $$BEGIN
  IF to_regclass('tender.region_profile_rules') IS NOT NULL THEN
    DROP POLICY IF EXISTS configuration_tenant_isolation ON tender.region_profile_rules;
    CREATE POLICY configuration_tenant_isolation ON tender.region_profile_rules
    USING(EXISTS(
      SELECT 1 FROM tender.region_profile_versions version
      WHERE version.id=region_version_id AND tender.runtime_tenant_allowed(version.tenant_id)
    ))
    WITH CHECK(EXISTS(
      SELECT 1 FROM tender.region_profile_versions version
      WHERE version.id=region_version_id AND tender.runtime_tenant_allowed(version.tenant_id)
    ));
  END IF;
END $$;

COMMIT;
