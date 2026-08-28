BEGIN;

-- 087 is deployable before the broader Tender runtime-role migration (108).
-- Keep the shared SaaS execution role non-login and fail-safe when it has not
-- yet been provisioned by an earlier environment bootstrap.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='saas_runtime') THEN
    CREATE ROLE saas_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;

ALTER TABLE saas.iam_subject_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.iam_subject_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON saas.iam_subject_bindings;
CREATE POLICY tenant_isolation ON saas.iam_subject_bindings
  USING(saas.tenant_matches(tenant_id))
  WITH CHECK(saas.tenant_matches(tenant_id));

CREATE OR REPLACE FUNCTION saas.resolve_iam_subject_binding(p_issuer text, p_subject text, p_email text)
RETURNS TABLE(user_id uuid, tenant_id uuid, email text, role text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, saas, iam
AS $$
  SELECT b.user_id,b.tenant_id,b.email,m.role
  FROM saas.iam_subject_bindings b
  JOIN iam.users u ON u.id=b.user_id AND u.active=true
  JOIN saas.tenant_memberships m ON m.user_id=b.user_id AND m.tenant_id=b.tenant_id AND m.status='ACTIVE'
  WHERE b.issuer=p_issuer AND b.subject=p_subject AND b.revoked_at IS NULL
    AND lower(b.email)=lower(p_email) AND lower(u.email)=lower(p_email)
$$;

REVOKE ALL ON saas.iam_subject_bindings FROM saas_runtime;
REVOKE ALL ON FUNCTION saas.resolve_iam_subject_binding(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION saas.resolve_iam_subject_binding(text,text,text) TO saas_runtime;

COMMIT;
