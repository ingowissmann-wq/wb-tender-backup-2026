BEGIN;

ALTER TABLE tender.portal_credential_companies
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS replaced_at timestamptz,
  ADD COLUMN IF NOT EXISTS replaced_by uuid REFERENCES tender.portal_credential_secrets(id);

UPDATE tender.portal_credential_companies SET active=false;
WITH current_scope AS (
  SELECT DISTINCT ON (credential.portal_id,scope.company_id)
    scope.credential_id,scope.company_id
  FROM tender.portal_credential_companies scope
  JOIN tender.portal_credential_secrets credential ON credential.id=scope.credential_id
  WHERE credential.status<>'REVOKED'
  ORDER BY credential.portal_id,scope.company_id,credential.version DESC,credential.created_at DESC
)
UPDATE tender.portal_credential_companies scope
SET active=true,replaced_at=NULL,replaced_by=NULL
FROM current_scope current
WHERE scope.credential_id=current.credential_id AND scope.company_id=current.company_id;

DROP INDEX IF EXISTS tender.portal_credential_one_active;

UPDATE tender.portal_credential_secrets credential
SET status=CASE WHEN EXISTS(
      SELECT 1 FROM tender.portal_credential_companies scope
      WHERE scope.credential_id=credential.id AND scope.active
    ) THEN 'ACTIVE' ELSE 'REPLACED' END,
    revoked_at=CASE WHEN EXISTS(
      SELECT 1 FROM tender.portal_credential_companies scope
      WHERE scope.credential_id=credential.id AND scope.active
    ) THEN NULL ELSE coalesce(credential.revoked_at,now()) END
WHERE credential.status<>'REVOKED';

CREATE INDEX IF NOT EXISTS portal_credential_companies_active_lookup
  ON tender.portal_credential_companies(company_id,credential_id) WHERE active;

CREATE INDEX IF NOT EXISTS portal_credential_active_portal_version
  ON tender.portal_credential_secrets(portal_id,version DESC) WHERE status='ACTIVE';

CREATE OR REPLACE FUNCTION tender.enforce_portal_scope_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM tender.portal_credential_secrets credential
    JOIN tender.portal_credential_companies company_scope ON company_scope.credential_id=credential.id
    WHERE credential.id=NEW.credential_id AND credential.portal_id=NEW.portal_id
      AND company_scope.company_id=NEW.company_id
      AND (NEW.status NOT IN('ACTIVE','LOGIN_STARTED','WAITING_FOR_USER','MFA_REQUIRED','LOGIN_SUCCESSFUL')
        OR (credential.status='ACTIVE' AND company_scope.active=true))
  ) THEN
    RAISE EXCEPTION 'portal company credential scope mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='portal_login_continuations' THEN
    IF coalesce(NEW.lot_key,'')<>'' AND NOT EXISTS(
      SELECT 1 FROM tender.lots lot WHERE lot.tender_id=NEW.tender_id AND lot.external_id=NEW.lot_key
      UNION ALL
      SELECT 1 FROM tender.enrichment_lots lot
      JOIN tender.enrichment_versions version ON version.id=lot.enrichment_version_id
      WHERE version.tender_id=NEW.tender_id AND lot.lot_key=NEW.lot_key
    ) THEN
      RAISE EXCEPTION 'portal tender lot scope mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

COMMIT;
