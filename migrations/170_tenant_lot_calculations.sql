BEGIN;
CREATE UNIQUE INDEX lot_assignment_tenant_binding ON tenant_portal.lot_assignment_versions(tenant_id,id);
CREATE TABLE tenant_portal.lot_calculation_versions(
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 assignment_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 status text NOT NULL CHECK(status IN('CALCULATED','BLOCKED')),
 bindings jsonb NOT NULL,
 facts jsonb NOT NULL,
 provenance jsonb NOT NULL,
 result jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES iam.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,assignment_id) REFERENCES tenant_portal.lot_assignment_versions(tenant_id,id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,assignment_id,version)
);
CREATE TABLE tenant_portal.lot_calculation_files(
 tenant_id uuid NOT NULL,
 calculation_id uuid NOT NULL,
 file_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,calculation_id,file_id),
 FOREIGN KEY(tenant_id,calculation_id) REFERENCES tenant_portal.lot_calculation_versions(tenant_id,id),
 FOREIGN KEY(tenant_id,file_id) REFERENCES tenant_portal.files(tenant_id,id)
);
ALTER TABLE tenant_portal.lot_calculation_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_portal.lot_calculation_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_portal.lot_calculation_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_portal.lot_calculation_files FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_portal.lot_calculation_versions USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
CREATE POLICY tenant_isolation ON tenant_portal.lot_calculation_files USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
REVOKE ALL ON tenant_portal.lot_calculation_versions,tenant_portal.lot_calculation_files FROM PUBLIC,tender_api_runtime,wb_tender_api_login;
GRANT SELECT,INSERT ON tenant_portal.lot_calculation_versions,tenant_portal.lot_calculation_files TO tender_api_runtime;
COMMIT;
