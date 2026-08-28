\set ON_ERROR_STOP on
\getenv backup_password WB_TENDER_BACKUP_PASSWORD

-- A complete logical backup must read FORCE RLS tables with row_security=off.
-- This dedicated operations login is therefore read-only but BYPASSRLS; it is
-- never mounted into API, worker or scheduler containers.
SELECT format('CREATE ROLE wb_tender_backup_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD %L', :'backup_password')
WHERE NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wb_tender_backup_login') \gexec
SELECT format('ALTER ROLE wb_tender_backup_login PASSWORD %L', :'backup_password') \gexec
ALTER ROLE wb_tender_backup_login NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
GRANT CONNECT ON DATABASE wb_platform TO wb_tender_backup_login;
GRANT pg_read_all_data TO wb_tender_backup_login;
ALTER ROLE wb_tender_backup_login SET default_transaction_read_only=true;
ALTER ROLE wb_tender_backup_login SET statement_timeout=0;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wb_tender_backup_login' AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN
    RAISE EXCEPTION 'unsafe backup login role';
  END IF;
END $$;
