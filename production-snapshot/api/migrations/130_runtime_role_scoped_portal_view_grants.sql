BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tender_api_runtime') THEN
    GRANT SELECT ON tender.current_tender_company_portal_role_scopes,
      tender.current_portal_host_capability_truth TO tender_api_runtime;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tender_worker_runtime') THEN
    GRANT SELECT ON tender.current_tender_company_portal_role_scopes,
      tender.current_portal_host_capability_truth TO tender_worker_runtime;
  END IF;
END $$;

INSERT INTO app.schema_migrations(version,description)
VALUES('0130-runtime-role-scoped-portal-view-grants',
  'Allow existing API and worker runtime roles to read security-invoker portal role and host capability views')
ON CONFLICT(version) DO NOTHING;

COMMIT;
