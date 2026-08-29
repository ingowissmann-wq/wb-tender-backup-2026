\set ON_ERROR_STOP on

BEGIN;

INSERT INTO tender.portal_registry(id,display_name,canonical_domain,adapter_validation_status,adapter_enabled)
VALUES('00000000-0000-4000-8000-000000001229','RLS 122 isolated acceptance','rls-122.invalid',
  'NO_ACTIVE_TENDER_FOR_VALIDATION',false);

CREATE TEMP TABLE context122_companies ON COMMIT DROP AS
SELECT active.company_id,binding.tenant_id,row_number() OVER(ORDER BY active.legal_name)::integer ordinal
FROM tender.enterprise_company_links active
JOIN saas.legacy_company_tenant_bindings binding ON binding.company_id=active.company_id
WHERE active.active;

CREATE ROLE context122_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA tender,saas TO context122_runtime;
GRANT SELECT ON tender.enterprise_company_links TO context122_runtime;
GRANT SELECT ON saas.legacy_company_tenant_bindings TO context122_runtime;
GRANT SELECT ON context122_companies TO context122_runtime;
GRANT SELECT ON tender.portal_credential_companies TO context122_runtime;
GRANT INSERT ON tender.portal_credential_secrets TO context122_runtime;
GRANT EXECUTE ON FUNCTION tender.runtime_uuid_value(text),tender.runtime_uuid_list(text),
  tender.runtime_company_allowed(uuid),tender.runtime_tenant_allowed(uuid),
  tender.resolve_runtime_tenants(uuid[]) TO context122_runtime;

SET ROLE context122_runtime;

DO $$
DECLARE company record; inserted_count integer:=0;
BEGIN
  FOR company IN
    SELECT company_id,tenant_id FROM context122_companies ORDER BY ordinal
  LOOP
    PERFORM set_config('app.tenant_id',company.tenant_id::text,true);
    PERFORM set_config('app.tenant_ids',company.tenant_id::text,true);
    PERFORM set_config('app.company_ids',company.company_id::text,true);
    PERFORM set_config('app.portal_credential_company_id',company.company_id::text,true);
    inserted_count:=inserted_count+1;
    INSERT INTO tender.portal_credential_secrets(id,portal_id,version,ciphertext,iv,auth_tag,
      username_masked,read_only,account_confirmed,submission_capable,status)
    VALUES(('00000000-0000-4000-8000-'||lpad((122900+inserted_count)::text,12,'0'))::uuid,
      '00000000-0000-4000-8000-000000001229',inserted_count,
      decode(repeat('a',64),'hex'),decode(repeat('b',24),'hex'),decode(repeat('c',32),'hex'),
      'isolated-rls-test',true,false,false,'ACTIVE');
  END LOOP;
  IF inserted_count<>6 THEN RAISE EXCEPTION 'expected_six_active_companies_got_%',inserted_count; END IF;
END $$;

DO $$
DECLARE first_company uuid;second_company uuid;tenant uuid;denied boolean:=false;
BEGIN
  SELECT company_id,tenant_id INTO first_company,tenant FROM context122_companies WHERE ordinal=1;
  SELECT company_id INTO second_company FROM context122_companies WHERE ordinal=2;
  PERFORM set_config('app.tenant_id',tenant::text,true);
  PERFORM set_config('app.tenant_ids',tenant::text,true);
  PERFORM set_config('app.company_ids',first_company::text,true);
  PERFORM set_config('app.portal_credential_company_id',second_company::text,true);
  BEGIN
    INSERT INTO tender.portal_credential_secrets(id,portal_id,version,ciphertext,iv,auth_tag,
      username_masked,read_only,account_confirmed,submission_capable,status)
    VALUES('00000000-0000-4000-8000-000000001299','00000000-0000-4000-8000-000000001229',99,
      decode(repeat('d',64),'hex'),decode(repeat('e',24),'hex'),decode(repeat('f',32),'hex'),
      'must-be-denied',true,false,false,'ACTIVE');
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'cross_company_insert_was_not_denied'; END IF;
END $$;

RESET ROLE;

DO $$
BEGIN
  IF (SELECT count(*) FROM tender.portal_credential_secrets
      WHERE portal_id='00000000-0000-4000-8000-000000001229')<>6 THEN
    RAISE EXCEPTION 'six_company_insert_count_mismatch';
  END IF;
  IF EXISTS(SELECT 1 FROM tender.portal_credential_secrets
      WHERE id='00000000-0000-4000-8000-000000001299') THEN
    RAISE EXCEPTION 'denied_cross_company_row_exists';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.schema_migrations
      WHERE version='0122-portal-credential-secret-insert-scope') THEN
    RAISE EXCEPTION 'migration_122_marker_missing';
  END IF;
END $$;

SELECT 'portal_credential_rls_122_all_6_companies_and_cross_company_denial' result;

ROLLBACK;
