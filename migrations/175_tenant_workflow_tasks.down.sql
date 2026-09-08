BEGIN;
SET LOCAL row_security=off;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM tenant_portal.workflow_task_versions) THEN RAISE EXCEPTION 'workflow_tasks_not_empty_preserve_customer_data'; END IF; END $$;
DROP TABLE tenant_portal.workflow_task_versions;
DROP INDEX tenant_portal.lot_assignment_task_binding;
COMMIT;
