\set ON_ERROR_STOP on
\getenv api_password WB_TENDER_API_RUNTIME_PASSWORD
\getenv worker_password WB_TENDER_WORKER_RUNTIME_PASSWORD
\getenv scheduler_password WB_TENDER_SCHEDULER_RUNTIME_PASSWORD
\getenv admin_password WB_ADMIN_RUNTIME_PASSWORD

-- Password values are supplied as psql variables from root-only files. They
-- must never be committed, echoed or passed as command-line literals.
SELECT format('CREATE ROLE wb_tender_api_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'api_password')
WHERE NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wb_tender_api_login') \gexec
SELECT format('CREATE ROLE wb_tender_worker_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'worker_password')
WHERE NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wb_tender_worker_login') \gexec
SELECT format('CREATE ROLE wb_tender_scheduler_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'scheduler_password')
WHERE NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wb_tender_scheduler_login') \gexec
SELECT format('CREATE ROLE wb_admin_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'admin_password')
WHERE NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wb_admin_login') \gexec

SELECT format('ALTER ROLE wb_tender_api_login PASSWORD %L', :'api_password') \gexec
SELECT format('ALTER ROLE wb_tender_worker_login PASSWORD %L', :'worker_password') \gexec
SELECT format('ALTER ROLE wb_tender_scheduler_login PASSWORD %L', :'scheduler_password') \gexec
SELECT format('ALTER ROLE wb_admin_login PASSWORD %L', :'admin_password') \gexec

GRANT tender_api_runtime TO wb_tender_api_login;
GRANT tender_worker_runtime TO wb_tender_worker_login;
GRANT tender_scheduler_runtime TO wb_tender_scheduler_login;
GRANT wb_admin_runtime TO wb_admin_login;
ALTER ROLE wb_tender_api_login SET statement_timeout='30s';
ALTER ROLE wb_tender_worker_login SET statement_timeout='5min';
ALTER ROLE wb_tender_scheduler_login SET statement_timeout='30min';
ALTER ROLE wb_admin_login SET statement_timeout='30s';

DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['wb_tender_api_login','wb_tender_worker_login','wb_tender_scheduler_login','wb_admin_login'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN
      RAISE EXCEPTION 'unsafe runtime login role: %',role_name;
    END IF;
  END LOOP;
END $$;
