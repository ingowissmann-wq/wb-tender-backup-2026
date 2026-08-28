BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE tender.portal_credential_secrets
  ADD COLUMN IF NOT EXISTS account_type text,
  ADD COLUMN IF NOT EXISTS authorized_capabilities text[],
  ADD COLUMN IF NOT EXISTS bound_host text;

ALTER TABLE tender.portal_credential_secrets
  DROP CONSTRAINT IF EXISTS portal_credential_account_type_check,
  ADD CONSTRAINT portal_credential_account_type_check CHECK (
    account_type IS NULL OR account_type IN (
      'DISCOVERY_ACCOUNT','NOTICE_ACCOUNT','BUYER_PUBLICATION_ACCOUNT',
      'BIDDER_PORTAL_ACCOUNT','DOCUMENT_ACCESS_ACCOUNT','SUBMISSION_ACCOUNT'
    )
  ) NOT VALID,
  DROP CONSTRAINT IF EXISTS portal_credential_capabilities_check,
  ADD CONSTRAINT portal_credential_capabilities_check CHECK (
    authorized_capabilities IS NULL OR authorized_capabilities <@ ARRAY[
      'NOTICE_SEARCH','NOTICE_VIEW','SAVED_SEARCHES','ALERTS','PUBLIC_DOCUMENT_ACCESS',
      'AUTHENTICATED_DOCUMENT_ACCESS','NOTICE_PUBLICATION','BUYER_ACCOUNT',
      'BIDDER_REGISTRATION','BIDDER_LOGIN','TENDER_DOCUMENT_DOWNLOAD','BID_SUBMISSION',
      'SUBMISSION_STATUS','RECEIPT_DOWNLOAD'
    ]::text[]
  ) NOT VALID,
  DROP CONSTRAINT IF EXISTS portal_credential_bound_host_check,
  ADD CONSTRAINT portal_credential_bound_host_check CHECK (
    bound_host IS NULL OR (bound_host=lower(bound_host) AND bound_host !~ '[/:@]')
  ) NOT VALID;

ALTER TABLE tender.portal_credential_secrets
  VALIDATE CONSTRAINT portal_credential_account_type_check;
ALTER TABLE tender.portal_credential_secrets
  VALIDATE CONSTRAINT portal_credential_capabilities_check;
ALTER TABLE tender.portal_credential_secrets
  VALIDATE CONSTRAINT portal_credential_bound_host_check;

COMMENT ON COLUMN tender.portal_credential_secrets.account_type IS
  'Purpose-bound account type. NULL preserves untouched legacy credentials until an explicit user action creates a new version.';
COMMENT ON COLUMN tender.portal_credential_secrets.authorized_capabilities IS
  'Explicit allowlist for this credential version; never inferred from a domain suffix.';
COMMENT ON COLUMN tender.portal_credential_secrets.bound_host IS
  'Exact lower-case portal host for this credential version.';

CREATE OR REPLACE VIEW tender.current_tender_company_portal_credential_scopes
WITH (security_barrier=true) AS
WITH active_bindings AS (
  SELECT credential.portal_id,scope.company_id,
         count(DISTINCT credential.id)::int active_credential_count,
         min(credential.id::text)::uuid credential_id
  FROM tender.portal_credential_secrets credential
  JOIN tender.portal_credential_companies scope
    ON scope.credential_id=credential.id AND scope.active=true
  JOIN tender.enterprise_company_links company
    ON company.company_id=scope.company_id AND company.active=true
  JOIN tender.portal_registry portal ON portal.id=credential.portal_id
  WHERE credential.status='ACTIVE'
    AND credential.revoked_at IS NULL
    AND (credential.valid_until IS NULL OR credential.valid_until>now())
    AND (
      credential.account_type IS NULL
      OR (
        credential.bound_host=lower(portal.canonical_domain)
        AND credential.authorized_capabilities && ARRAY[
          'BIDDER_LOGIN','TENDER_DOCUMENT_DOWNLOAD','BID_SUBMISSION'
        ]::text[]
      )
    )
  GROUP BY credential.portal_id,scope.company_id
  HAVING count(DISTINCT credential.id)=1
)
SELECT mapping.tender_id,mapping.portal_id,binding.company_id,
       binding.credential_id,binding.active_credential_count,
       mapping.mapping_status
FROM tender.current_tender_portal_mapping_truth mapping
JOIN active_bindings binding ON binding.portal_id=mapping.portal_id
WHERE mapping.mapping_status='UNIQUE_CANONICAL_PROFILE';

COMMENT ON VIEW tender.current_tender_company_portal_credential_scopes IS
  'Exact tender/company/portal/credential scope for capability-checked login and document jobs. Notice/discovery/publication-only accounts are excluded.';

-- Typed notice/discovery accounts must never enter the tender action scope.
-- NULL keeps untouched legacy credentials operational until their next explicit
-- versioned save; every newly typed credential is fail-closed by capability.
CREATE OR REPLACE VIEW tender.current_registered_tender_company_portals
WITH (security_barrier=true) AS
WITH active_bindings AS (
  SELECT credential.portal_id,scope.company_id,
         count(DISTINCT credential.id)::int active_credential_count,
         min(credential.id::text)::uuid credential_id
  FROM tender.portal_credential_secrets credential
  JOIN tender.portal_credential_companies scope
    ON scope.credential_id=credential.id AND scope.active=true
  JOIN tender.enterprise_company_links company
    ON company.company_id=scope.company_id AND company.active=true
  JOIN tender.portal_registry portal ON portal.id=credential.portal_id
  WHERE credential.status='ACTIVE'
    AND credential.revoked_at IS NULL
    AND (credential.valid_until IS NULL OR credential.valid_until>now())
    AND (
      credential.account_type IS NULL
      OR (
        credential.bound_host=lower(portal.canonical_domain)
        AND 'BID_SUBMISSION'=ANY(coalesce(credential.authorized_capabilities,'{}'::text[]))
      )
    )
  GROUP BY credential.portal_id,scope.company_id
  HAVING count(DISTINCT credential.id)=1
)
SELECT mapping.tender_id,mapping.portal_id,binding.company_id,
       binding.credential_id,binding.active_credential_count,
       mapping.mapping_status
FROM tender.current_tender_portal_mapping_truth mapping
JOIN active_bindings binding ON binding.portal_id=mapping.portal_id
WHERE mapping.mapping_status='UNIQUE_CANONICAL_PROFILE';

COMMENT ON VIEW tender.current_registered_tender_company_portals IS
  'Fail-closed exact tender/company/portal scope. Typed credentials additionally require exact host binding and BID_SUBMISSION capability; notice/discovery accounts never constitute bidder registration.';

COMMIT;
