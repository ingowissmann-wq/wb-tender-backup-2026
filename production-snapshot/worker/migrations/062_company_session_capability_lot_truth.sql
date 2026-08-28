BEGIN;

ALTER TABLE tender.portal_read_sessions
  ADD COLUMN IF NOT EXISTS company_id uuid;

ALTER TABLE tender.portal_login_continuations
  ADD COLUMN IF NOT EXISTS company_id uuid;

WITH continuation_scope AS(
  SELECT continuation.id,
    coalesce(login_job.company_id,resume_job.company_id) company_id
  FROM tender.portal_login_continuations continuation
  LEFT JOIN tender.autopilot_queue login_job ON login_job.id=continuation.login_job_id
  LEFT JOIN tender.autopilot_queue resume_job ON resume_job.id=continuation.job_id
  WHERE continuation.company_id IS NULL
    AND (login_job.company_id IS NULL OR resume_job.company_id IS NULL OR login_job.company_id=resume_job.company_id)
)
UPDATE tender.portal_login_continuations continuation
SET company_id=job.company_id
FROM continuation_scope job
WHERE continuation.id=job.id
  AND job.company_id IS NOT NULL
  AND EXISTS(
    SELECT 1 FROM tender.portal_credential_companies scope
    WHERE scope.credential_id=continuation.credential_id
      AND scope.company_id=job.company_id
  );

UPDATE tender.portal_login_continuations
SET status='SESSION_EXPIRED'
WHERE company_id IS NULL
  AND status IN('LOGIN_STARTED','WAITING_FOR_USER','MFA_REQUIRED');

UPDATE tender.portal_read_sessions session
SET company_id=scope.company_id
FROM (
  SELECT credential_id,(array_agg(company_id ORDER BY company_id))[1] company_id
  FROM tender.portal_credential_companies
  GROUP BY credential_id
  HAVING count(*)=1
) scope
WHERE session.company_id IS NULL AND scope.credential_id=session.credential_id;

UPDATE tender.portal_read_sessions
SET status='REVOKED',revoked_at=coalesce(revoked_at,now()),
    verification_status='COMPANY_SCOPE_UNVERIFIED'
WHERE status='ACTIVE' AND company_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS portal_credential_companies_binding_unique
  ON tender.portal_credential_companies(credential_id,company_id);

ALTER TABLE tender.portal_read_sessions
  DROP CONSTRAINT IF EXISTS portal_read_sessions_company_binding_fk,
  ADD CONSTRAINT portal_read_sessions_company_binding_fk
    FOREIGN KEY(credential_id,company_id)
    REFERENCES tender.portal_credential_companies(credential_id,company_id),
  DROP CONSTRAINT IF EXISTS portal_read_sessions_active_company_check,
  ADD CONSTRAINT portal_read_sessions_active_company_check
    CHECK(status<>'ACTIVE' OR company_id IS NOT NULL);

ALTER TABLE tender.portal_login_continuations
  DROP CONSTRAINT IF EXISTS portal_login_continuations_company_binding_fk,
  ADD CONSTRAINT portal_login_continuations_company_binding_fk
    FOREIGN KEY(credential_id,company_id)
    REFERENCES tender.portal_credential_companies(credential_id,company_id),
  DROP CONSTRAINT IF EXISTS portal_login_continuations_live_company_check,
  ADD CONSTRAINT portal_login_continuations_live_company_check
    CHECK(status NOT IN('LOGIN_STARTED','WAITING_FOR_USER','MFA_REQUIRED','LOGIN_SUCCESSFUL') OR company_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS portal_read_sessions_scope_lookup
  ON tender.portal_read_sessions(portal_id,credential_id,company_id,created_at DESC);
CREATE INDEX IF NOT EXISTS portal_login_continuations_scope_lookup
  ON tender.portal_login_continuations(tender_id,company_id,lot_key,portal_id,credential_id,created_at DESC);
DROP INDEX IF EXISTS tender.portal_login_continuations_active_uniq;
CREATE UNIQUE INDEX portal_login_continuations_active_uniq
  ON tender.portal_login_continuations(user_id,tender_id,company_id,coalesce(lot_key,''),portal_id,desired_action)
  WHERE status IN('LOGIN_STARTED','WAITING_FOR_USER','MFA_REQUIRED');

CREATE OR REPLACE FUNCTION tender.enforce_portal_scope_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM tender.portal_credential_secrets credential
    JOIN tender.portal_credential_companies company_scope ON company_scope.credential_id=credential.id
    WHERE credential.id=NEW.credential_id AND credential.portal_id=NEW.portal_id
      AND company_scope.company_id=NEW.company_id
  ) THEN
    RAISE EXCEPTION 'portal company credential scope mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='portal_login_continuations' AND coalesce(NEW.lot_key,'')<>'' AND NOT EXISTS(
    SELECT 1 FROM tender.lots lot WHERE lot.tender_id=NEW.tender_id AND lot.external_id=NEW.lot_key
    UNION ALL
    SELECT 1 FROM tender.enrichment_lots lot
    JOIN tender.enrichment_versions version ON version.id=lot.enrichment_version_id
    WHERE version.tender_id=NEW.tender_id AND lot.lot_key=NEW.lot_key
  ) THEN
    RAISE EXCEPTION 'portal tender lot scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS portal_read_sessions_scope_binding ON tender.portal_read_sessions;
CREATE TRIGGER portal_read_sessions_scope_binding
  BEFORE INSERT OR UPDATE OF portal_id,credential_id,company_id ON tender.portal_read_sessions
  FOR EACH ROW WHEN(NEW.company_id IS NOT NULL)
  EXECUTE FUNCTION tender.enforce_portal_scope_binding();
DROP TRIGGER IF EXISTS portal_login_continuations_scope_binding ON tender.portal_login_continuations;
CREATE TRIGGER portal_login_continuations_scope_binding
  BEFORE INSERT OR UPDATE OF tender_id,lot_key,company_id,portal_id,credential_id ON tender.portal_login_continuations
  FOR EACH ROW WHEN(NEW.company_id IS NOT NULL)
  EXECUTE FUNCTION tender.enforce_portal_scope_binding();

CREATE OR REPLACE VIEW tender.current_portal_company_eligibility AS
WITH companies AS(
  SELECT company_id,legal_name,display_name,sector_slug,active
  FROM tender.enterprise_company_links WHERE active=true
), portals AS(
  SELECT p.* FROM tender.portal_registry p
  LEFT JOIN tender.portal_capability_profiles profile ON profile.portal_id=p.id
  WHERE p.adapter_enabled=true AND coalesce(profile.portal_type,'E_VERGABEPORTAL')<>'BEKANNTMACHUNGSPLATTFORM'
), credential AS(
  SELECT DISTINCT ON(secret.portal_id,scope.company_id) secret.*,scope.company_id
  FROM tender.portal_credential_secrets secret
  JOIN tender.portal_credential_companies scope ON scope.credential_id=secret.id
  WHERE secret.status='ACTIVE'
  ORDER BY secret.portal_id,scope.company_id,secret.version DESC
), identity AS(
  SELECT DISTINCT ON(portal_id,credential_id) * FROM tender.portal_account_identity_evidence
  WHERE authoritative=true AND credential_id IS NOT NULL AND (valid_until IS NULL OR valid_until>now())
  ORDER BY portal_id,credential_id,verified_at DESC
), features AS(
  SELECT profile.portal_id,
    max(feature.portal_support) FILTER(WHERE feature.feature_key='SUBMISSION') submission_portal_support,
    bool_or(feature.autopilot_supported) FILTER(WHERE feature.feature_key='DOCUMENT_DOWNLOAD') document_download_supported
  FROM tender.portal_capability_profiles profile
  JOIN tender.portal_capability_features feature ON feature.profile_id=profile.id
  GROUP BY profile.portal_id
), latest_login AS(
  SELECT DISTINCT ON(portal_id,credential_id,company_id) portal_id,credential_id,company_id,last_verified_at,verification_status,status,expires_at
  FROM tender.portal_read_sessions
  WHERE company_id IS NOT NULL
  ORDER BY portal_id,credential_id,company_id,created_at DESC
), grants AS(
  SELECT portal_id,credential_id,company_id,true internal_submission_permission
  FROM tender.portal_submission_access_grants WHERE status='ACTIVE'
)
SELECT p.id portal_id,p.display_name portal_name,p.canonical_domain,p.adapter_id,
  c.company_id,c.legal_name company_name,c.sector_slug,c.active,
  (i.id IS NOT NULL) account_present,(cr.id IS NOT NULL) credential_present,
  coalesce(g.internal_submission_permission,false) internal_submission_permission,
  coalesce(i.technically_authenticatable,false) technically_authenticatable,
  i.account_holder_name,i.legal_bidder_name,i.account_model,i.multi_company_selection,
  s.selectable company_selectable,coalesce(i.document_access,false) document_access,
  coalesce(s.submission_usable,false) submission_possible,
  l.last_verified_at last_verified_login,i.verified_at last_verified_submission_account_check,
  coalesce(s.evidence_source,i.evidence_source,'KANONISCHE_PORTALREGISTRY_OHNE_ACCOUNTNACHWEIS') evidence_source,
  CASE
    WHEN i.authoritative AND i.account_model='MULTI_COMPANY' AND s.selectable=true AND s.submission_usable=true THEN 'MULTI_COMPANY_SELECTION_AVAILABLE'
    WHEN i.authoritative AND lower(i.legal_bidder_name)=lower(c.legal_name) AND s.submission_usable=true AND coalesce(g.internal_submission_permission,false) THEN 'SUBMISSION_READY'
    WHEN i.authoritative AND lower(i.legal_bidder_name)=lower(c.legal_name) AND s.submission_usable=true AND NOT coalesce(g.internal_submission_permission,false) THEN 'SUBMISSION_PERMISSION_REQUIRED'
    WHEN i.authoritative AND i.legal_bidder_name IS NOT NULL AND lower(i.legal_bidder_name)<>lower(c.legal_name) AND coalesce(s.selectable,false)=false THEN 'ACCOUNT_FOR_OTHER_COMPANY'
    WHEN i.authoritative AND i.document_access=true THEN 'DOCUMENT_ACCESS_ONLY'
    WHEN cr.id IS NOT NULL THEN 'NOT_AUTHORITATIV_VERIFIED'
    WHEN f.submission_portal_support='SUPPORTED' THEN 'REGISTRATION_REQUIRED'
    WHEN p.last_successful_document_fetch_at IS NOT NULL AND coalesce(f.document_download_supported,false) THEN 'DOCUMENT_ACCESS_ONLY'
    ELSE 'NOT_AUTHORITATIV_VERIFIED'
  END eligibility_status
FROM portals p CROSS JOIN companies c
LEFT JOIN credential cr ON cr.portal_id=p.id AND cr.company_id=c.company_id
LEFT JOIN identity i ON i.portal_id=p.id AND i.credential_id=cr.id
LEFT JOIN tender.portal_company_selection_evidence s ON s.account_evidence_id=i.id AND s.company_id=c.company_id
LEFT JOIN grants g ON g.portal_id=p.id AND g.credential_id=cr.id AND g.company_id=c.company_id
LEFT JOIN features f ON f.portal_id=p.id
LEFT JOIN latest_login l ON l.portal_id=p.id AND l.credential_id=cr.id AND l.company_id=c.company_id;

UPDATE tender.portal_capability_features
SET actively_configured=false
WHERE actively_configured=true AND autopilot_supported=false;

UPDATE tender.portal_capability_features
SET production_tested=false
WHERE production_tested=true
  AND autopilot_supported=false;

UPDATE tender.portal_capability_features
SET browser_acceptance_passed=false
WHERE browser_acceptance_passed=true
  AND (autopilot_supported=false OR production_tested=false);

ALTER TABLE tender.portal_capability_features
  DROP CONSTRAINT IF EXISTS portal_capability_configured_truth_check,
  ADD CONSTRAINT portal_capability_configured_truth_check
    CHECK(NOT actively_configured OR autopilot_supported),
  DROP CONSTRAINT IF EXISTS portal_capability_production_truth_check,
  ADD CONSTRAINT portal_capability_production_truth_check
    CHECK(NOT production_tested OR autopilot_supported),
  DROP CONSTRAINT IF EXISTS portal_capability_browser_truth_check,
  ADD CONSTRAINT portal_capability_browser_truth_check
    CHECK(NOT browser_acceptance_passed OR (autopilot_supported AND production_tested));

CREATE UNIQUE INDEX IF NOT EXISTS lots_tender_external_id_unique
  ON tender.lots(tender_id,external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS enrichment_lots_id_version_unique
  ON tender.enrichment_lots(id,enrichment_version_id);
ALTER TABLE tender.enrichment_documents
  DROP CONSTRAINT IF EXISTS enrichment_documents_lot_version_fk,
  ADD CONSTRAINT enrichment_documents_lot_version_fk
    FOREIGN KEY(lot_id,enrichment_version_id)
    REFERENCES tender.enrichment_lots(id,enrichment_version_id);

UPDATE tender.autopilot_queue
SET safe_error_code=NULL,error_detail_safe=NULL
WHERE status IN('SUCCEEDED','DONE') AND error_code IS NULL;

CREATE OR REPLACE FUNCTION tender.enforce_success_status_truth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN('SUCCEEDED','DONE') AND NEW.error_code IS NULL THEN
    NEW.safe_error_code:=NULL;
    NEW.error_detail_safe:=NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS autopilot_queue_success_status_truth ON tender.autopilot_queue;
CREATE TRIGGER autopilot_queue_success_status_truth
  BEFORE INSERT OR UPDATE ON tender.autopilot_queue
  FOR EACH ROW EXECUTE FUNCTION tender.enforce_success_status_truth();

COMMIT;
