BEGIN;
CREATE TABLE tenant_portal.offer_packages(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,calculation_id uuid NOT NULL,document_review_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 created_by uuid NOT NULL REFERENCES iam.users(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,calculation_id,version),
 FOREIGN KEY(tenant_id,calculation_id) REFERENCES tenant_portal.lot_calculation_versions(tenant_id,id),
 FOREIGN KEY(tenant_id,document_review_id) REFERENCES tenant_portal.lot_document_reviews(tenant_id,id)
);
CREATE TABLE tenant_portal.offer_package_files(
 tenant_id uuid NOT NULL,package_id uuid NOT NULL,file_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,package_id,file_id),
 FOREIGN KEY(tenant_id,package_id) REFERENCES tenant_portal.offer_packages(tenant_id,id),
 FOREIGN KEY(tenant_id,file_id) REFERENCES tenant_portal.files(tenant_id,id)
);
CREATE TABLE tenant_portal.offer_package_decisions(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,package_id uuid NOT NULL,
 decision text NOT NULL CHECK(decision IN('APPROVED','REJECTED')),reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 1000),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 created_by uuid NOT NULL REFERENCES iam.users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,package_id) REFERENCES tenant_portal.offer_packages(tenant_id,id)
);
CREATE INDEX offer_package_latest_decision ON tenant_portal.offer_package_decisions(tenant_id,package_id,created_at DESC,id DESC);
ALTER TABLE tenant_portal.offer_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_portal.offer_packages FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_portal.offer_package_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_portal.offer_package_files FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_portal.offer_package_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_portal.offer_package_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_portal.offer_packages USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
CREATE POLICY tenant_isolation ON tenant_portal.offer_package_files USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
CREATE POLICY tenant_isolation ON tenant_portal.offer_package_decisions USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
REVOKE ALL ON tenant_portal.offer_packages,tenant_portal.offer_package_files,tenant_portal.offer_package_decisions FROM PUBLIC,tender_api_runtime,wb_tender_api_login;
GRANT SELECT,INSERT ON tenant_portal.offer_packages,tenant_portal.offer_package_files,tenant_portal.offer_package_decisions TO tender_api_runtime;
COMMIT;
