BEGIN;
DROP TRIGGER saas_automation_usage ON tenant_portal.jobs;
DROP FUNCTION saas.reserve_automation_usage();
DROP TABLE saas.automation_usage;
DROP TRIGGER saas_workspace_binding ON tenant_portal.tender_workspaces;
DROP FUNCTION saas.preserve_workspace_binding();
DROP TRIGGER saas_membership_tenant_binding ON saas.tenant_memberships;
DROP TRIGGER saas_company_tenant_binding ON saas.tenant_companies;
DO $$ DECLARE previous text; BEGIN
 IF (SELECT count(*) FROM saas.release_165_function_snapshot)<>1 THEN RAISE EXCEPTION 'release_165_snapshot_invalid'; END IF;
 SELECT definition INTO previous FROM saas.release_165_function_snapshot;
 EXECUTE previous;
END $$;
DROP TABLE saas.release_165_function_snapshot;
COMMIT;
