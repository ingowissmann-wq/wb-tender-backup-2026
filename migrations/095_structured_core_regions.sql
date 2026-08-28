BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';

CREATE TABLE IF NOT EXISTS tender.configuration_tenants(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tender.configuration_tenants(tenant_key) VALUES('WB_INTERNAL_TENDER') ON CONFLICT(tenant_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS tender.configuration_scopes(
  tenant_id uuid NOT NULL REFERENCES tender.configuration_tenants(id),
  company_id uuid NOT NULL REFERENCES tender.enterprise_company_links(company_id),
  canonical_service text NOT NULL CHECK(canonical_service IN('security','cleaning','facility_management','sicherheitstechnik','emergency_services')),
  profile_id uuid NOT NULL REFERENCES tender.company_profiles(id),
  active_region_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,company_id,canonical_service,profile_id),
  UNIQUE(company_id,canonical_service)
);
INSERT INTO tender.configuration_scopes(tenant_id,company_id,canonical_service,profile_id)
SELECT tenant.id,company.company_id,
 CASE company.sector_slug WHEN 'facility-management' THEN 'facility_management' WHEN 'emergency-services' THEN 'emergency_services' ELSE company.sector_slug END,
 company.tender_profile_id
FROM tender.enterprise_company_links company CROSS JOIN tender.configuration_tenants tenant
WHERE tenant.tenant_key='WB_INTERNAL_TENDER' AND company.active=true
  AND company.sector_slug IN('security','cleaning','facility-management','sicherheitstechnik','emergency-services')
ON CONFLICT(company_id,canonical_service) DO NOTHING;

ALTER TABLE tender.configuration_versions ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE tender.configuration_versions ADD COLUMN IF NOT EXISTS canonical_service text;
ALTER TABLE tender.configuration_versions ADD COLUMN IF NOT EXISTS profile_id uuid;
UPDATE tender.configuration_versions version SET
 tenant_id=scope.tenant_id,canonical_service=scope.canonical_service,profile_id=scope.profile_id
FROM tender.configuration_scopes scope
WHERE scope.company_id=version.company_id
 AND scope.canonical_service=CASE version.service_line WHEN 'facility-management' THEN 'facility_management' WHEN 'emergency-services' THEN 'emergency_services' ELSE version.service_line END
 AND (version.tenant_id IS NULL OR version.canonical_service IS NULL OR version.profile_id IS NULL);
DO $guard$ BEGIN
 IF EXISTS(SELECT 1 FROM tender.configuration_versions WHERE tenant_id IS NULL OR company_id IS NULL OR canonical_service IS NULL OR profile_id IS NULL) THEN
  RAISE EXCEPTION 'configuration_scope_backfill_incomplete';
 END IF;
END $guard$;
ALTER TABLE tender.configuration_versions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE tender.configuration_versions ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE tender.configuration_versions ALTER COLUMN canonical_service SET NOT NULL;
ALTER TABLE tender.configuration_versions ALTER COLUMN profile_id SET NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='configuration_versions_exact_scope_fk') THEN
  ALTER TABLE tender.configuration_versions ADD CONSTRAINT configuration_versions_exact_scope_fk
   FOREIGN KEY(tenant_id,company_id,canonical_service,profile_id)
   REFERENCES tender.configuration_scopes(tenant_id,company_id,canonical_service,profile_id);
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS configuration_versions_exact_history_idx
 ON tender.configuration_versions(tenant_id,company_id,canonical_service,profile_id,version_no DESC);

CREATE TABLE IF NOT EXISTS tender.region_profile_versions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  canonical_service text NOT NULL,
  profile_id uuid NOT NULL,
  configuration_version_id uuid NOT NULL UNIQUE REFERENCES tender.configuration_versions(id),
  version_no bigint NOT NULL,
  status text NOT NULL CHECK(status IN('ACTIVE','SUPERSEDED')),
  configuration_checksum char(64) NOT NULL,
  activated_by uuid NOT NULL REFERENCES iam.users(id),
  activated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,company_id,canonical_service,profile_id)
   REFERENCES tender.configuration_scopes(tenant_id,company_id,canonical_service,profile_id),
  UNIQUE(tenant_id,company_id,canonical_service,profile_id,version_no)
);
CREATE TABLE IF NOT EXISTS tender.region_profile_rules(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  region_version_id uuid NOT NULL REFERENCES tender.region_profile_versions(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK(ordinal>=0),
  region_type text NOT NULL CHECK(region_type IN('PLACE_RADIUS','POSTAL_CODE','NUTS','STATE')),
  normalized_place text,
  postal_code text CHECK(postal_code IS NULL OR postal_code ~ '^\d{5}$'),
  state_name text,
  radius_km numeric CHECK(radius_km IS NULL OR (radius_km>0 AND radius_km<=500)),
  nuts_code text CHECK(nuts_code IS NULL OR nuts_code ~ '^DE[1-9A-G][A-Z0-9]{0,2}$'),
  latitude double precision,
  longitude double precision,
  validation_status text NOT NULL CHECK(validation_status='VALID'),
  validation_evidence jsonb NOT NULL,
  UNIQUE(region_version_id,ordinal)
);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='configuration_scopes_active_region_fk') THEN
  ALTER TABLE tender.configuration_scopes ADD CONSTRAINT configuration_scopes_active_region_fk
   FOREIGN KEY(active_region_version_id) REFERENCES tender.region_profile_versions(id);
 END IF;
END $$;

ALTER TABLE tender.region_evaluations ADD COLUMN IF NOT EXISTS region_profile_version_id uuid REFERENCES tender.region_profile_versions(id);
ALTER TABLE tender.region_evaluations ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tender.configuration_tenants(id);
ALTER TABLE tender.region_evaluations ADD COLUMN IF NOT EXISTS canonical_service text;
ALTER TABLE tender.region_evaluations ADD COLUMN IF NOT EXISTS profile_id uuid REFERENCES tender.company_profiles(id);
ALTER TABLE tender.management_inbox ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tender.configuration_tenants(id);
ALTER TABLE tender.management_inbox ADD COLUMN IF NOT EXISTS canonical_service text;
ALTER TABLE tender.management_inbox ADD COLUMN IF NOT EXISTS profile_id uuid REFERENCES tender.company_profiles(id);
ALTER TABLE tender.management_inbox ADD COLUMN IF NOT EXISTS region_profile_version_id uuid REFERENCES tender.region_profile_versions(id);
CREATE INDEX IF NOT EXISTS region_evaluations_active_scope_idx
 ON tender.region_evaluations(tenant_id,company_id,canonical_service,profile_id,configuration_version_id,region_profile_version_id,tender_id,evaluation_version DESC);
CREATE INDEX IF NOT EXISTS management_inbox_exact_region_scope_idx
 ON tender.management_inbox(tenant_id,company_id,canonical_service,profile_id,region_profile_version_id,tender_id,created_at DESC);

CREATE OR REPLACE VIEW tender.current_scoped_region_evaluations AS
SELECT DISTINCT ON(evaluation.tender_id,evaluation.company_id,evaluation.lot_id,scope.canonical_service)
 evaluation.*,scope.tenant_id active_tenant_id,scope.canonical_service active_canonical_service,scope.profile_id active_profile_id,
 scope.active_region_version_id active_region_profile_version_id,active.version_id active_configuration_version_id
FROM tender.configuration_scopes scope
LEFT JOIN tender.configuration_active_parameters active ON active.company_id=scope.company_id AND active.parameter_key='A08'
 AND (CASE active.service_line WHEN 'facility-management' THEN 'facility_management' WHEN 'emergency-services' THEN 'emergency_services' ELSE active.service_line END)=scope.canonical_service
JOIN tender.region_evaluations evaluation ON evaluation.company_id=scope.company_id AND evaluation.configuration_version_id IS NOT DISTINCT FROM active.version_id
 AND (scope.active_region_version_id IS NULL OR evaluation.region_profile_version_id=scope.active_region_version_id)
 AND (evaluation.tenant_id IS NULL OR evaluation.tenant_id=scope.tenant_id)
 AND (evaluation.canonical_service IS NULL OR evaluation.canonical_service=scope.canonical_service)
 AND (evaluation.profile_id IS NULL OR evaluation.profile_id=scope.profile_id)
ORDER BY evaluation.tender_id,evaluation.company_id,evaluation.lot_id,scope.canonical_service,evaluation.evaluation_version DESC;

ALTER TABLE tender.configuration_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender.configuration_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender.region_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender.region_profile_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender.region_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender.management_inbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS configuration_tenant_isolation ON tender.configuration_scopes;
CREATE POLICY configuration_tenant_isolation ON tender.configuration_scopes
 USING(tenant_id::text=current_setting('app.configuration_tenant_id',true))
 WITH CHECK(tenant_id::text=current_setting('app.configuration_tenant_id',true));
DROP POLICY IF EXISTS configuration_tenant_isolation ON tender.configuration_versions;
CREATE POLICY configuration_tenant_isolation ON tender.configuration_versions
 USING(tenant_id::text=current_setting('app.configuration_tenant_id',true))
 WITH CHECK(tenant_id::text=current_setting('app.configuration_tenant_id',true));
DROP POLICY IF EXISTS configuration_tenant_isolation ON tender.region_profile_versions;
CREATE POLICY configuration_tenant_isolation ON tender.region_profile_versions
 USING(tenant_id::text=current_setting('app.configuration_tenant_id',true))
 WITH CHECK(tenant_id::text=current_setting('app.configuration_tenant_id',true));
DROP POLICY IF EXISTS configuration_tenant_isolation ON tender.region_profile_rules;
CREATE POLICY configuration_tenant_isolation ON tender.region_profile_rules
 USING(EXISTS(SELECT 1 FROM tender.region_profile_versions version WHERE version.id=region_version_id AND version.tenant_id::text=current_setting('app.configuration_tenant_id',true)))
 WITH CHECK(EXISTS(SELECT 1 FROM tender.region_profile_versions version WHERE version.id=region_version_id AND version.tenant_id::text=current_setting('app.configuration_tenant_id',true)));
DROP POLICY IF EXISTS configuration_tenant_isolation ON tender.region_evaluations;
CREATE POLICY configuration_tenant_isolation ON tender.region_evaluations
 USING(tenant_id::text=current_setting('app.configuration_tenant_id',true))
 WITH CHECK(tenant_id::text=current_setting('app.configuration_tenant_id',true));
DROP POLICY IF EXISTS configuration_tenant_isolation ON tender.management_inbox;
CREATE POLICY configuration_tenant_isolation ON tender.management_inbox
 USING(tenant_id::text=current_setting('app.configuration_tenant_id',true))
 WITH CHECK(tenant_id::text=current_setting('app.configuration_tenant_id',true));

COMMIT;
