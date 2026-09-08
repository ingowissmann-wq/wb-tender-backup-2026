BEGIN;
CREATE UNIQUE INDEX credential_vault_session_binding ON tenant_portal.credential_vault(tenant_id,company_id,portal_id,id);
CREATE TABLE tenant_portal.portal_sessions(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,company_id uuid NOT NULL,portal_id uuid NOT NULL,credential_id uuid NOT NULL,
 credential_revision integer NOT NULL CHECK(credential_revision>0),
 status text NOT NULL CHECK(status IN('CHECKING','VERIFIED','FAILED','MFA_REQUIRED','STALE')),
 result_code text NOT NULL,key_version text NOT NULL CHECK(key_version ~ '^[A-Za-z0-9_-]{1,64}$'),
 ciphertext bytea CHECK(ciphertext IS NULL OR octet_length(ciphertext) BETWEEN 30 AND 1048576),
 expires_at timestamptz,revoked_at timestamptz,created_by uuid NOT NULL REFERENCES iam.users(id),created_at timestamptz NOT NULL DEFAULT now(),verified_at timestamptz,
 CHECK(status<>'VERIFIED' OR (ciphertext IS NOT NULL AND expires_at IS NOT NULL AND verified_at IS NOT NULL)),
 FOREIGN KEY(tenant_id,company_id,portal_id,credential_id) REFERENCES tenant_portal.credential_vault(tenant_id,company_id,portal_id,id)
);
CREATE INDEX portal_sessions_latest ON tenant_portal.portal_sessions(tenant_id,credential_id,created_at DESC,id DESC);
ALTER TABLE tenant_portal.portal_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_portal.portal_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_portal.portal_sessions USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
CREATE FUNCTION tenant_portal.guard_session_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (NEW.id,NEW.tenant_id,NEW.company_id,NEW.portal_id,NEW.credential_id,NEW.credential_revision,NEW.key_version,NEW.created_by,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.company_id,OLD.portal_id,OLD.credential_id,OLD.credential_revision,OLD.key_version,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'portal_session_binding_immutable'; END IF;
 IF OLD.status<>'CHECKING' AND (NEW.status,NEW.result_code,NEW.ciphertext,NEW.expires_at,NEW.verified_at) IS DISTINCT FROM (OLD.status,OLD.result_code,OLD.ciphertext,OLD.expires_at,OLD.verified_at) THEN RAISE EXCEPTION 'portal_session_result_immutable'; END IF;
 IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN RAISE EXCEPTION 'portal_session_revocation_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_session_binding BEFORE UPDATE ON tenant_portal.portal_sessions FOR EACH ROW EXECUTE FUNCTION tenant_portal.guard_session_binding();
REVOKE ALL ON tenant_portal.portal_sessions FROM PUBLIC,tender_api_runtime,wb_tender_api_login;
GRANT SELECT,INSERT ON tenant_portal.portal_sessions TO tender_api_runtime;
GRANT UPDATE(status,result_code,ciphertext,expires_at,verified_at,revoked_at) ON tenant_portal.portal_sessions TO tender_api_runtime;
REVOKE ALL ON FUNCTION tenant_portal.guard_session_binding() FROM PUBLIC;
COMMIT;
