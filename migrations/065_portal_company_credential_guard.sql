BEGIN;

-- The encrypted secret stays opaque.  The active binding is the authoritative
-- key and must resolve to at most one credential for a portal/company pair.
CREATE OR REPLACE FUNCTION tender.enforce_one_active_portal_company_credential()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bound_portal_id uuid;
BEGIN
  IF NOT NEW.active THEN
    RETURN NEW;
  END IF;

  SELECT portal_id INTO bound_portal_id
  FROM tender.portal_credential_secrets
  WHERE id=NEW.credential_id;

  IF bound_portal_id IS NULL THEN
    RAISE EXCEPTION 'portal credential binding has no portal'
      USING ERRCODE='23514';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(bound_portal_id::text || ':' || NEW.company_id::text, 0)
  );

  IF EXISTS(
    SELECT 1
    FROM tender.portal_credential_companies other_scope
    JOIN tender.portal_credential_secrets other_credential
      ON other_credential.id=other_scope.credential_id
    WHERE other_scope.company_id=NEW.company_id
      AND other_scope.active=true
      AND other_credential.portal_id=bound_portal_id
      AND other_credential.status='ACTIVE'
      AND other_scope.credential_id<>NEW.credential_id
  ) THEN
    RAISE EXCEPTION 'active portal company credential already exists'
      USING ERRCODE='23505';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS portal_credential_company_active_guard
  ON tender.portal_credential_companies;
CREATE TRIGGER portal_credential_company_active_guard
  BEFORE INSERT OR UPDATE OF credential_id,company_id,active
  ON tender.portal_credential_companies
  FOR EACH ROW
  EXECUTE FUNCTION tender.enforce_one_active_portal_company_credential();

COMMIT;
