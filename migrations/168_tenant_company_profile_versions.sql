BEGIN;
CREATE TABLE tenant_portal.company_profile_versions(
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 company_id uuid NOT NULL,
 service_line text NOT NULL CHECK(service_line IN('cleaning','security','facility_management')),
 version integer NOT NULL CHECK(version>0),
 valid_from date NOT NULL,
 valid_until date CHECK(valid_until>=valid_from),
 regions jsonb NOT NULL CHECK(jsonb_typeof(regions)='object'),
 parameters jsonb NOT NULL CHECK(jsonb_typeof(parameters)='object'),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 created_by uuid NOT NULL REFERENCES iam.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,company_id) REFERENCES saas.tenant_companies(tenant_id,id),
 UNIQUE(tenant_id,company_id,service_line,version),
 UNIQUE(tenant_id,id)
);
ALTER TABLE tenant_portal.company_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_portal.company_profile_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_portal.company_profile_versions
 USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
REVOKE ALL ON tenant_portal.company_profile_versions FROM PUBLIC,tender_api_runtime,wb_tender_api_login;
GRANT SELECT,INSERT ON tenant_portal.company_profile_versions TO tender_api_runtime;
CREATE INDEX company_profile_effective_lookup ON tenant_portal.company_profile_versions(tenant_id,company_id,service_line,valid_from DESC,version DESC);
COMMIT;
