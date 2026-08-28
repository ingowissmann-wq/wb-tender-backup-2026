BEGIN;

CREATE OR REPLACE FUNCTION tender.portal_session_effective_status(
  stored_status text,
  expires_at timestamptz,
  revoked_at timestamptz,
  verification_status text,
  evaluated_at timestamptz DEFAULT now()
) RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN revoked_at IS NOT NULL OR stored_status='REVOKED' THEN 'RELOGIN_REQUIRED_REVOKED'
    WHEN expires_at IS NULL OR expires_at<=evaluated_at OR stored_status='EXPIRED' THEN 'RELOGIN_REQUIRED_EXPIRED'
    WHEN stored_status IS DISTINCT FROM 'ACTIVE' THEN 'RELOGIN_REQUIRED_INACTIVE'
    WHEN verification_status IS DISTINCT FROM 'VERIFIED_RESTORED_READ_ONLY_PAGE' THEN 'RELOGIN_REQUIRED_UNVERIFIED'
    ELSE 'ACTIVE'
  END
$$;

COMMENT ON FUNCTION tender.portal_session_effective_status(text,timestamptz,timestamptz,text,timestamptz)
  IS 'Canonical company/credential-scoped portal session truth. Only ACTIVE is usable for fan-out, downloads, reconciliation, or preflight.';

UPDATE tender.portal_read_sessions
SET status='EXPIRED',revoked_at=coalesce(revoked_at,now()),
    verification_status=CASE
      WHEN verification_status='VERIFIED_RESTORED_READ_ONLY_PAGE' THEN 'EXPIRED_VERIFIED_SESSION'
      ELSE verification_status
    END
WHERE tender.portal_session_effective_status(status,expires_at,revoked_at,verification_status)<>'ACTIVE'
  AND status='ACTIVE';

CREATE OR REPLACE FUNCTION tender.canonical_portal_adapter_validation_status(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN value IN('VALIDATED_REAL','LIVE_VALIDATED','PRODUCTION_VALIDATED') THEN 'PRODUCTION_VALIDATED'
    ELSE value
  END
$$;

COMMENT ON FUNCTION tender.canonical_portal_adapter_validation_status(text)
  IS 'Backward-compatible normalization for historical production-validation aliases.';

UPDATE tender.portal_registry
SET adapter_validation_status=tender.canonical_portal_adapter_validation_status(adapter_validation_status),
    updated_at=now()
WHERE adapter_validation_status IN('VALIDATED_REAL','LIVE_VALIDATED');

CREATE OR REPLACE FUNCTION tender.normalize_portal_adapter_validation_status()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.adapter_validation_status:=tender.canonical_portal_adapter_validation_status(NEW.adapter_validation_status);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS portal_registry_normalize_validation_status ON tender.portal_registry;
CREATE TRIGGER portal_registry_normalize_validation_status
  BEFORE INSERT OR UPDATE OF adapter_validation_status ON tender.portal_registry
  FOR EACH ROW EXECUTE FUNCTION tender.normalize_portal_adapter_validation_status();

UPDATE tender.portal_capability_features
SET production_tested=false,browser_acceptance_passed=false
WHERE production_tested=true
  AND (verified_at IS NULL OR nullif(btrim(evidence_note),'') IS NULL);

UPDATE tender.portal_capability_features
SET browser_acceptance_passed=false
WHERE browser_acceptance_passed=true
  AND (production_tested=false OR verified_at IS NULL OR nullif(btrim(evidence_note),'') IS NULL);

ALTER TABLE tender.portal_capability_features
  DROP CONSTRAINT IF EXISTS portal_capability_production_evidence_check,
  ADD CONSTRAINT portal_capability_production_evidence_check
    CHECK(NOT production_tested OR (autopilot_supported AND verified_at IS NOT NULL AND nullif(btrim(evidence_note),'') IS NOT NULL)),
  DROP CONSTRAINT IF EXISTS portal_capability_browser_evidence_check,
  ADD CONSTRAINT portal_capability_browser_evidence_check
    CHECK(NOT browser_acceptance_passed OR (autopilot_supported AND production_tested AND verified_at IS NOT NULL AND nullif(btrim(evidence_note),'') IS NOT NULL));

ALTER TABLE tender.signature_documents
  DROP CONSTRAINT IF EXISTS signature_documents_never_transmitted,
  ADD CONSTRAINT signature_documents_never_transmitted CHECK(transmitted=false) NOT VALID;
ALTER TABLE tender.signature_documents VALIDATE CONSTRAINT signature_documents_never_transmitted;

ALTER TABLE tender.submission_contexts
  DROP CONSTRAINT IF EXISTS submission_contexts_never_transmitted,
  ADD CONSTRAINT submission_contexts_never_transmitted CHECK(transmitted=false) NOT VALID;
ALTER TABLE tender.submission_contexts VALIDATE CONSTRAINT submission_contexts_never_transmitted;

COMMENT ON CONSTRAINT signature_documents_never_transmitted ON tender.signature_documents
  IS 'Global external-submission lock. A future explicitly authorized migration may replace this named constraint.';
COMMENT ON CONSTRAINT submission_contexts_never_transmitted ON tender.submission_contexts
  IS 'Global external-submission lock. A future explicitly authorized migration may replace this named constraint.';

COMMIT;
