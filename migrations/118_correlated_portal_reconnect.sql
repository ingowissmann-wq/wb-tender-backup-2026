BEGIN;

ALTER TABLE tender.portal_login_continuations
  ADD COLUMN IF NOT EXISTS tender_version_id uuid REFERENCES tender.tender_versions(id),
  ADD COLUMN IF NOT EXISTS enrichment_version_id uuid REFERENCES tender.enrichment_versions(id),
  ADD COLUMN IF NOT EXISTS blocked_action text NOT NULL DEFAULT 'DOCUMENT_FETCH',
  ADD COLUMN IF NOT EXISTS correlation_token_hash text,
  ADD COLUMN IF NOT EXISTS correlation_consumed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_verification_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE tender.portal_login_continuations
  DROP CONSTRAINT IF EXISTS portal_login_continuations_blocked_action_check,
  ADD CONSTRAINT portal_login_continuations_blocked_action_check
    CHECK(blocked_action IN('DOCUMENT_FETCH','PARTICIPATION_PREPARE','PORTAL_MESSAGES','DRAFT_ACTION')),
  DROP CONSTRAINT IF EXISTS portal_login_continuations_correlation_hash_check,
  ADD CONSTRAINT portal_login_continuations_correlation_hash_check
    CHECK(correlation_token_hash IS NULL OR correlation_token_hash ~ '^[0-9a-f]{64}$'),
  DROP CONSTRAINT IF EXISTS portal_login_continuations_version_scope_check,
  ADD CONSTRAINT portal_login_continuations_version_scope_check
    CHECK(enrichment_version_id IS NULL OR tender_version_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS portal_login_continuations_correlation_token_unique
  ON tender.portal_login_continuations(correlation_token_hash)
  WHERE correlation_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS portal_login_continuations_reconnect_lookup
  ON tender.portal_login_continuations(
    portal_id,company_id,credential_id,tender_id,enrichment_version_id,
    coalesce(lot_key,''),blocked_action,expires_at DESC
  );

CREATE OR REPLACE FUNCTION tender.enforce_portal_reconnect_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tender_version_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM tender.tender_versions version
    WHERE version.id=NEW.tender_version_id AND version.tender_id=NEW.tender_id
  ) THEN
    RAISE EXCEPTION 'portal continuation tender version mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.enrichment_version_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM tender.enrichment_versions version
    WHERE version.id=NEW.enrichment_version_id AND version.tender_id=NEW.tender_id
  ) THEN
    RAISE EXCEPTION 'portal continuation enrichment version mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS portal_login_continuations_reconnect_binding
  ON tender.portal_login_continuations;
CREATE TRIGGER portal_login_continuations_reconnect_binding
  BEFORE INSERT OR UPDATE OF tender_id,tender_version_id,enrichment_version_id
  ON tender.portal_login_continuations
  FOR EACH ROW EXECUTE FUNCTION tender.enforce_portal_reconnect_binding();

COMMIT;
