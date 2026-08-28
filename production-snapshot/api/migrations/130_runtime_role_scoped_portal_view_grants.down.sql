BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tender_api_runtime') THEN
    REVOKE SELECT ON tender.current_tender_company_portal_role_scopes,
      tender.current_portal_host_capability_truth FROM tender_api_runtime;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tender_worker_runtime') THEN
    REVOKE SELECT ON tender.current_tender_company_portal_role_scopes,
      tender.current_portal_host_capability_truth FROM tender_worker_runtime;
  END IF;
END $$;

DELETE FROM app.schema_migrations
WHERE version='0130-runtime-role-scoped-portal-view-grants';

COMMIT;
