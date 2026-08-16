CREATE TABLE IF NOT EXISTS tender.portal_account_identity_evidence(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_id uuid NOT NULL REFERENCES tender.portal_registry(id),
  credential_id uuid REFERENCES tender.portal_credential_secrets(id),
  account_holder_name text,
  legal_bidder_name text,
  account_model text NOT NULL DEFAULT 'UNKNOWN',
  multi_company_selection boolean,
  authoritative boolean NOT NULL DEFAULT false,
  technically_authenticatable boolean,
  document_access boolean,
  submission_account_verified boolean NOT NULL DEFAULT false,
  evidence_source text NOT NULL,
  evidence_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_at timestamptz NOT NULL,
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(account_model IN('SINGLE_COMPANY','MULTI_COMPANY','UNKNOWN'))
);

CREATE UNIQUE INDEX IF NOT EXISTS portal_account_identity_current_unique
  ON tender.portal_account_identity_evidence(portal_id,credential_id,verified_at);

CREATE TABLE IF NOT EXISTS tender.portal_company_selection_evidence(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_evidence_id uuid NOT NULL REFERENCES tender.portal_account_identity_evidence(id),
  company_id uuid NOT NULL,
  selectable boolean,
  submission_usable boolean,
  evidence_source text NOT NULL,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_evidence_id,company_id)
);

CREATE OR REPLACE VIEW tender.current_portal_company_eligibility AS
WITH companies AS(
  SELECT company_id,legal_name,display_name,sector_slug,active
  FROM tender.enterprise_company_links WHERE active=true
), portals AS(
  SELECT p.* FROM tender.portal_registry p
  LEFT JOIN tender.portal_capability_profiles profile ON profile.portal_id=p.id
  WHERE p.adapter_enabled=true AND coalesce(profile.portal_type,'E_VERGABEPORTAL')<>'BEKANNTMACHUNGSPLATTFORM'
), credential AS(
  SELECT DISTINCT ON(portal_id) * FROM tender.portal_credential_secrets
  WHERE status='ACTIVE' ORDER BY portal_id,version DESC
), identity AS(
  SELECT DISTINCT ON(portal_id) * FROM tender.portal_account_identity_evidence
  WHERE authoritative=true AND (valid_until IS NULL OR valid_until>now())
  ORDER BY portal_id,verified_at DESC
), features AS(
  SELECT profile.portal_id,
    max(feature.portal_support) FILTER(WHERE feature.feature_key='SUBMISSION') submission_portal_support,
    bool_or(feature.autopilot_supported) FILTER(WHERE feature.feature_key='DOCUMENT_DOWNLOAD') document_download_supported
  FROM tender.portal_capability_profiles profile
  JOIN tender.portal_capability_features feature ON feature.profile_id=profile.id
  GROUP BY profile.portal_id
), latest_login AS(
  SELECT DISTINCT ON(portal_id) portal_id,last_verified_at,verification_status,status,expires_at
  FROM tender.portal_read_sessions ORDER BY portal_id,created_at DESC
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
LEFT JOIN credential cr ON cr.portal_id=p.id
LEFT JOIN identity i ON i.portal_id=p.id AND (i.credential_id=cr.id OR i.credential_id IS NULL)
LEFT JOIN tender.portal_company_selection_evidence s ON s.account_evidence_id=i.id AND s.company_id=c.company_id
LEFT JOIN grants g ON g.portal_id=p.id AND g.credential_id=cr.id AND g.company_id=c.company_id
LEFT JOIN features f ON f.portal_id=p.id
LEFT JOIN latest_login l ON l.portal_id=p.id;

COMMENT ON VIEW tender.current_portal_company_eligibility IS
  'Current, additive Portal x Company submission eligibility. Historical sessions, credentials, approvals and packages remain unchanged.';

WITH inserted AS(
  INSERT INTO tender.portal_account_identity_evidence(
    portal_id,credential_id,account_holder_name,legal_bidder_name,account_model,
    multi_company_selection,authoritative,technically_authenticatable,document_access,
    submission_account_verified,evidence_source,evidence_context,verified_at)
  SELECT p.id,c.id,'WB-Consulting GmbH','WB-Consulting GmbH','SINGLE_COMPANY',
    false,true,true,true,true,'PRODUCTION_BROWSER_ACCOUNT_AND_FINAL_OFFER_PREVIEW',
    jsonb_build_object('tender','Aufsichts- und Schließdienst für die SGV Bamberg','lot','LOT-0001','externalWrite',false,'transmitted',false),
    '2026-08-08T05:56:56.576Z'::timestamptz
  FROM tender.portal_registry p
  JOIN LATERAL(SELECT * FROM tender.portal_credential_secrets x WHERE x.portal_id=p.id AND x.status='ACTIVE' ORDER BY version DESC LIMIT 1)c ON true
  WHERE p.id='5dc14f20-4da2-42a9-88e0-54d0a3516556'
    AND NOT EXISTS(SELECT 1 FROM tender.portal_account_identity_evidence x WHERE x.portal_id=p.id AND x.verified_at='2026-08-08T05:56:56.576Z')
  RETURNING id
)
INSERT INTO tender.portal_company_selection_evidence(account_evidence_id,company_id,selectable,submission_usable,evidence_source,verified_at)
SELECT inserted.id,company.company_id,false,false,'PRODUCTION_BROWSER_NO_COMPANY_SELECTOR_AND_LEGAL_BIDDER_FIXED',
  '2026-08-08T05:56:56.576Z'::timestamptz
FROM inserted CROSS JOIN tender.enterprise_company_links company WHERE company.active=true;

WITH inserted AS(
  INSERT INTO tender.portal_account_identity_evidence(
    portal_id,credential_id,account_holder_name,legal_bidder_name,account_model,
    multi_company_selection,authoritative,technically_authenticatable,document_access,
    submission_account_verified,evidence_source,evidence_context,verified_at)
  SELECT p.id,c.id,'WB-Security GmbH','WB-Security GmbH','SINGLE_COMPANY',
    false,true,true,true,false,'PRODUCTION_BROWSER_ACCOUNT_EDIT_AND_TENDER_WORKFLOW_READ_ONLY',
    jsonb_build_object('tender','Aufsichts- und Schließdienst für die SGV Bamberg','lot','LOT-0001','workflowAccessible',true,'submissionProcessEntered',false,'externalWrite',false,'transmitted',false),
    '2026-08-08T06:17:37Z'::timestamptz
  FROM tender.portal_registry p
  JOIN tender.portal_credential_secrets c ON c.portal_id=p.id AND c.id='2dc9541b-b5ee-4bac-8785-822e54b82084'
  WHERE p.id='5dc14f20-4da2-42a9-88e0-54d0a3516556'
    AND NOT EXISTS(SELECT 1 FROM tender.portal_account_identity_evidence x WHERE x.credential_id=c.id AND x.verified_at='2026-08-08T06:17:37Z')
  RETURNING id
)
INSERT INTO tender.portal_company_selection_evidence(account_evidence_id,company_id,selectable,submission_usable,evidence_source,verified_at)
SELECT inserted.id,company.company_id,company.legal_name='WB-Security GmbH',false,
  'PRODUCTION_BROWSER_SINGLE_COMPANY_PROFILE_AND_TENDER_WORKFLOW_READ_ONLY',
  '2026-08-08T06:17:37Z'::timestamptz
FROM inserted CROSS JOIN tender.enterprise_company_links company WHERE company.active=true;
