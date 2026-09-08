BEGIN;
CREATE TABLE tenant_portal.management_decisions(
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 calculation_id uuid NOT NULL,
 decision text NOT NULL CHECK(decision IN('APPROVED','REJECTED')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 1000),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 approved_payload_sha256 text NOT NULL CHECK(approved_payload_sha256 ~ '^[0-9a-f]{64}$'),
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
 created_by uuid NOT NULL REFERENCES iam.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,calculation_id) REFERENCES tenant_portal.lot_calculation_versions(tenant_id,id),
 UNIQUE(tenant_id,id)
);
CREATE INDEX management_calculation_latest ON tenant_portal.management_decisions(tenant_id,calculation_id,created_at DESC,id DESC);
ALTER TABLE tenant_portal.management_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_portal.management_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_portal.management_decisions USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
REVOKE ALL ON tenant_portal.management_decisions FROM PUBLIC,tender_api_runtime,wb_tender_api_login;
GRANT SELECT,INSERT ON tenant_portal.management_decisions TO tender_api_runtime;
COMMIT;
