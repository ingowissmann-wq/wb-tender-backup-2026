BEGIN;
CREATE UNIQUE INDEX company_profile_company_binding ON tenant_portal.company_profile_versions(tenant_id,company_id,id);
CREATE TABLE tenant_portal.lot_assignment_versions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 source_version_id uuid NOT NULL,
 lot_key text NOT NULL CHECK(length(lot_key) BETWEEN 1 AND 240),
 version integer NOT NULL CHECK(version>0),
 assignment_kind text NOT NULL CHECK(assignment_kind IN('AUTOMATIC','REVIEW_REQUIRED','MANUAL')),
 company_id uuid,
 profile_id uuid,
 snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[0-9a-f]{64}$'),
 details jsonb NOT NULL CHECK(jsonb_typeof(details)='object'),
 created_by uuid NOT NULL REFERENCES iam.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((company_id IS NULL)=(profile_id IS NULL)),
 CHECK(assignment_kind='REVIEW_REQUIRED' OR company_id IS NOT NULL),
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES tenant_portal.tender_workspaces(tenant_id,id),
 FOREIGN KEY(tenant_id,company_id,profile_id) REFERENCES tenant_portal.company_profile_versions(tenant_id,company_id,id),
 UNIQUE(tenant_id,workspace_id,lot_key,version),
 UNIQUE(tenant_id,workspace_id,lot_key,snapshot_sha256)
);
CREATE FUNCTION tenant_portal.validate_assignment_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM tenant_portal.tender_workspaces workspace JOIN tender.tender_versions source ON source.tender_id=workspace.public_tender_id
   WHERE workspace.tenant_id=NEW.tenant_id AND workspace.id=NEW.workspace_id AND source.id=NEW.source_version_id) THEN
   RAISE EXCEPTION 'assignment_source_binding_invalid';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION tenant_portal.validate_assignment_source() FROM PUBLIC;
CREATE TRIGGER assignment_source_binding BEFORE INSERT ON tenant_portal.lot_assignment_versions FOR EACH ROW EXECUTE FUNCTION tenant_portal.validate_assignment_source();
ALTER TABLE tenant_portal.lot_assignment_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_portal.lot_assignment_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_portal.lot_assignment_versions USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
REVOKE ALL ON tenant_portal.lot_assignment_versions FROM PUBLIC,tender_api_runtime,wb_tender_api_login;
GRANT SELECT,INSERT ON tenant_portal.lot_assignment_versions TO tender_api_runtime;
COMMIT;
