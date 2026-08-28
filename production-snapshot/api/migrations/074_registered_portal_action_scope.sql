BEGIN;

-- Portal registration is deliberately derived from the maintained portal UUID
-- and the exact active company/credential binding.  Document hosts and saved
-- sessions are not part of this truth model.
CREATE INDEX IF NOT EXISTS enrichment_versions_current_tender_version_idx
  ON tender.enrichment_versions(tender_id,version DESC)
  WHERE historical=false;

CREATE INDEX IF NOT EXISTS enrichment_documents_explicit_portal_idx
  ON tender.enrichment_documents(enrichment_version_id,(provenance->>'portalId'))
  WHERE nullif(provenance->>'portalId','') IS NOT NULL;

CREATE INDEX IF NOT EXISTS portal_credential_scope_active_company_idx
  ON tender.portal_credential_companies(company_id,credential_id)
  WHERE active=true;

CREATE OR REPLACE VIEW tender.current_tender_portal_mapping_truth
WITH (security_barrier=true) AS
WITH current_enrichment AS (
  SELECT DISTINCT ON(version.tender_id) version.id,version.tender_id
  FROM tender.enrichment_versions version
  WHERE version.historical=false
  ORDER BY version.tender_id,version.version DESC,version.created_at DESC,version.id DESC
), explicit_profiles AS (
  SELECT current.tender_id,nullif(document.provenance->>'portalId','') portal_key
  FROM current_enrichment current
  JOIN tender.enrichment_documents document
    ON document.enrichment_version_id=current.id
  WHERE nullif(document.provenance->>'portalId','') IS NOT NULL
), mapping_count AS (
  SELECT tender_id,count(DISTINCT portal_key)::int portal_mapping_count,
         min(portal_key) portal_key
  FROM explicit_profiles
  GROUP BY tender_id
)
SELECT mapping.tender_id,
       CASE WHEN mapping.portal_mapping_count=1 THEN portal.id END portal_id,
       mapping.portal_mapping_count,
       CASE
         WHEN mapping.portal_mapping_count<>1 THEN 'AMBIGUOUS'
         WHEN portal.id IS NULL THEN 'UNKNOWN_PROFILE'
         ELSE 'UNIQUE_CANONICAL_PROFILE'
       END mapping_status
FROM mapping_count mapping
LEFT JOIN tender.portal_registry portal
  ON portal.id::text=mapping.portal_key;

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
  WHERE credential.status='ACTIVE'
    AND credential.revoked_at IS NULL
    AND (credential.valid_until IS NULL OR credential.valid_until>now())
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
  'Fail-closed action scope. Requires one canonical portal profile and exactly one active, non-revoked, non-expired credential bound to the exact company. Domains, documents and sessions never constitute registration.';

COMMIT;
