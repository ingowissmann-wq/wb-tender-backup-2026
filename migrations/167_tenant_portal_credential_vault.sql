BEGIN;
CREATE TABLE tenant_portal.credential_vault(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 company_id uuid NOT NULL,
 portal_id uuid NOT NULL REFERENCES tender.portal_registry(id),
 label text NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 120),
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 30 AND 32768),
 revision integer NOT NULL CHECK(revision>0),
 key_version text NOT NULL CHECK(key_version ~ '^[A-Za-z0-9_-]{1,64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,company_id) REFERENCES saas.tenant_companies(tenant_id,id),
 UNIQUE(tenant_id,company_id,portal_id)
);
ALTER TABLE tenant_portal.credential_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_portal.credential_vault FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_portal.credential_vault
 USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
CREATE FUNCTION tenant_portal.guard_credential_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (NEW.id,NEW.tenant_id,NEW.company_id,NEW.portal_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.company_id,OLD.portal_id,OLD.created_at) THEN
  RAISE EXCEPTION 'credential_binding_immutable';
 END IF;
 IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'credential_revision_invalid'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_credential_binding BEFORE UPDATE ON tenant_portal.credential_vault FOR EACH ROW EXECUTE FUNCTION tenant_portal.guard_credential_binding();
REVOKE ALL ON tenant_portal.credential_vault FROM PUBLIC,tender_api_runtime,wb_tender_api_login;
GRANT SELECT,INSERT ON tenant_portal.credential_vault TO tender_api_runtime;
GRANT UPDATE(label,ciphertext,revision,key_version,updated_at) ON tenant_portal.credential_vault TO tender_api_runtime;
REVOKE ALL ON FUNCTION tenant_portal.guard_credential_binding() FROM PUBLIC;
COMMIT;
