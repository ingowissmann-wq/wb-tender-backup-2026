BEGIN;

ALTER TABLE saas.iam_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.iam_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON saas.iam_sessions;
CREATE POLICY tenant_isolation ON saas.iam_sessions
  USING(saas.tenant_matches(tenant_id))
  WITH CHECK(saas.tenant_matches(tenant_id));

CREATE OR REPLACE FUNCTION saas.create_iam_session(
  p_token_hash char(64), p_csrf_hash char(64), p_user_id uuid, p_tenant_id uuid,
  p_issuer text, p_subject text, p_email text, p_user_agent_hash char(64),
  p_mfa_verified_at timestamptz, p_email_verified_at timestamptz, p_expires_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas
AS $$
BEGIN
  INSERT INTO saas.iam_sessions(token_hash,csrf_hash,user_id,tenant_id,issuer,subject,email,user_agent_hash,mfa_verified_at,email_verified_at,expires_at)
  SELECT p_token_hash,p_csrf_hash,b.user_id,b.tenant_id,b.issuer,b.subject,b.email,p_user_agent_hash,p_mfa_verified_at,p_email_verified_at,p_expires_at
  FROM saas.iam_subject_bindings b
  WHERE b.issuer=p_issuer AND b.subject=p_subject AND b.user_id=p_user_id AND b.tenant_id=p_tenant_id
    AND lower(b.email)=lower(p_email) AND b.revoked_at IS NULL;
  RETURN FOUND;
END
$$;

CREATE OR REPLACE FUNCTION saas.get_iam_session(p_token_hash char(64))
RETURNS TABLE(token_hash char(64),csrf_hash char(64),user_id uuid,tenant_id uuid,issuer text,subject text,email text,user_agent_hash char(64),mfa_verified_at timestamptz,email_verified_at timestamptz,expires_at timestamptz,revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, saas
AS $$
  SELECT s.token_hash,s.csrf_hash,s.user_id,s.tenant_id,s.issuer,s.subject,s.email,s.user_agent_hash,s.mfa_verified_at,s.email_verified_at,s.expires_at,s.revoked_at
  FROM saas.iam_sessions s
  WHERE s.token_hash=p_token_hash AND s.revoked_at IS NULL AND s.expires_at>now()
$$;

CREATE OR REPLACE FUNCTION saas.revoke_iam_session(p_token_hash char(64)) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas
AS $$
BEGIN
  UPDATE saas.iam_sessions s SET revoked_at=now() WHERE s.token_hash=p_token_hash AND s.revoked_at IS NULL;
  RETURN FOUND;
END
$$;

REVOKE ALL ON saas.iam_sessions FROM saas_runtime;
REVOKE ALL ON FUNCTION saas.create_iam_session(char(64),char(64),uuid,uuid,text,text,text,char(64),timestamptz,timestamptz,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION saas.get_iam_session(char(64)) FROM PUBLIC;
REVOKE ALL ON FUNCTION saas.revoke_iam_session(char(64)) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION saas.create_iam_session(char(64),char(64),uuid,uuid,text,text,text,char(64),timestamptz,timestamptz,timestamptz) TO saas_runtime;
GRANT EXECUTE ON FUNCTION saas.get_iam_session(char(64)) TO saas_runtime;
GRANT EXECUTE ON FUNCTION saas.revoke_iam_session(char(64)) TO saas_runtime;

COMMIT;
