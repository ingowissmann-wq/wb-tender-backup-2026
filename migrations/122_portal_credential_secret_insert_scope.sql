BEGIN;

-- A new secret has no company binding until the following statement in the
-- credential-save transaction.  Keep the binding-based policy authoritative
-- for existing rows and add only the missing, exact INSERT check.
CREATE OR REPLACE FUNCTION tender.runtime_uuid_value(setting_name text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  raw text;
BEGIN
  raw:=current_setting(setting_name,true);
  IF raw IS NULL OR raw='' THEN RETURN NULL; END IF;
  RETURN raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS(
    SELECT 1
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname='tender'
      AND relation.relname='portal_credential_secrets'
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'portal_credential_secrets_forced_rls_required';
  END IF;
END $$;

-- The active-binding guard must resolve the just-inserted secret before its
-- company binding exists.  Keep ordinary row visibility unchanged and limit
-- the RLS bypass to this trigger-only function with a fixed search path.
ALTER FUNCTION tender.enforce_one_active_portal_company_credential()
  SECURITY DEFINER;
ALTER FUNCTION tender.enforce_one_active_portal_company_credential()
  SET search_path=pg_catalog,tender;

DROP POLICY IF EXISTS runtime_insert_scope
  ON tender.portal_credential_secrets;
CREATE POLICY runtime_insert_scope
  ON tender.portal_credential_secrets
  FOR INSERT
  WITH CHECK(
    tender.runtime_company_allowed(
      tender.runtime_uuid_value('app.portal_credential_company_id')
    )
    AND EXISTS(
      SELECT 1
      FROM tender.resolve_runtime_tenants(
        ARRAY[tender.runtime_uuid_value('app.portal_credential_company_id')]
      ) binding
      WHERE tender.runtime_tenant_allowed(binding.tenant_id)
    )
  );

INSERT INTO app.schema_migrations(version,description)
VALUES(
  '0122-portal-credential-secret-insert-scope',
  'Allow only an authorized transaction-local company to create and bind a new portal credential secret'
)
ON CONFLICT(version) DO NOTHING;

COMMIT;
