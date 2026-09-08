BEGIN;
CREATE TABLE tenant_portal.lot_document_reviews(
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 assignment_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 status text NOT NULL CHECK(status IN('REVIEW_REQUIRED','REVIEWED')),
 source_manifest jsonb NOT NULL CHECK(jsonb_typeof(source_manifest)='array'),
 requirements jsonb NOT NULL CHECK(jsonb_typeof(requirements)='array'),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[0-9a-f]{64}$'),
 coverage_confirmed boolean NOT NULL DEFAULT false,
 created_by uuid NOT NULL REFERENCES iam.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status<>'REVIEWED' OR coverage_confirmed),
 FOREIGN KEY(tenant_id,assignment_id) REFERENCES tenant_portal.lot_assignment_versions(tenant_id,id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,assignment_id,version)
);
CREATE TABLE tenant_portal.lot_document_review_files(
 tenant_id uuid NOT NULL,
 review_id uuid NOT NULL,
 file_id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN('PROCUREMENT_SOURCE','BID_EVIDENCE')),
 PRIMARY KEY(tenant_id,review_id,file_id,purpose),
 FOREIGN KEY(tenant_id,review_id) REFERENCES tenant_portal.lot_document_reviews(tenant_id,id),
 FOREIGN KEY(tenant_id,file_id) REFERENCES tenant_portal.files(tenant_id,id)
);
ALTER TABLE tenant_portal.lot_document_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_portal.lot_document_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_portal.lot_document_review_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_portal.lot_document_review_files FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_portal.lot_document_reviews USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
CREATE POLICY tenant_isolation ON tenant_portal.lot_document_review_files USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
REVOKE ALL ON tenant_portal.lot_document_reviews,tenant_portal.lot_document_review_files FROM PUBLIC,tender_api_runtime,wb_tender_api_login;
GRANT SELECT,INSERT ON tenant_portal.lot_document_reviews,tenant_portal.lot_document_review_files TO tender_api_runtime;
COMMIT;
