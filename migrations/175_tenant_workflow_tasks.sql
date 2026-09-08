BEGIN;
CREATE UNIQUE INDEX lot_assignment_task_binding ON tenant_portal.lot_assignment_versions(tenant_id,company_id,id);
CREATE TABLE tenant_portal.workflow_task_versions(
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, task_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 company_id uuid NOT NULL, assignment_id uuid, title text NOT NULL CHECK(length(title) BETWEEN 3 AND 240),
 description text NOT NULL, status text NOT NULL CHECK(status IN('OPEN','IN_PROGRESS','BLOCKED','DONE','CANCELLED')),
 assignee_user_id uuid, due_at timestamptz, deadline_source text NOT NULL,
 checklist jsonb NOT NULL CHECK(jsonb_typeof(checklist)='array' AND jsonb_array_length(checklist) BETWEEN 1 AND 30),
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 1000), request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 created_by uuid NOT NULL REFERENCES iam.users(id),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(due_at IS NULL OR length(deadline_source)>=10),
 FOREIGN KEY(tenant_id,company_id) REFERENCES saas.tenant_companies(tenant_id,id),
 FOREIGN KEY(tenant_id,company_id,assignment_id) REFERENCES tenant_portal.lot_assignment_versions(tenant_id,company_id,id),
 FOREIGN KEY(tenant_id,assignee_user_id) REFERENCES saas.tenant_memberships(tenant_id,user_id),
 UNIQUE(tenant_id,task_id,version)
);
CREATE INDEX workflow_tasks_latest ON tenant_portal.workflow_task_versions(tenant_id,task_id,version DESC);
ALTER TABLE tenant_portal.workflow_task_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_portal.workflow_task_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_portal.workflow_task_versions USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
REVOKE ALL ON tenant_portal.workflow_task_versions FROM PUBLIC,tender_api_runtime,wb_tender_api_login;
GRANT SELECT,INSERT ON tenant_portal.workflow_task_versions TO tender_api_runtime;
COMMIT;
