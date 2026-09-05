\set ON_ERROR_STOP on

DO $role$
DECLARE
  safe boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tender_api_runtime') THEN
    CREATE ROLE tender_api_runtime
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOLOGIN;
  ELSE
    SELECT NOT rolsuper
       AND NOT rolcreatedb
       AND NOT rolcreaterole
       AND rolinherit
       AND NOT rolbypassrls
       AND NOT rolcanlogin
       AND NOT EXISTS (
         SELECT 1
         FROM pg_auth_members
         WHERE member = 'tender_api_runtime'::regrole
       )
      INTO safe
      FROM pg_roles
      WHERE rolname = 'tender_api_runtime';

    IF safe IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'existing tender_api_runtime role is not least privilege';
    END IF;
  END IF;
END
$role$;
