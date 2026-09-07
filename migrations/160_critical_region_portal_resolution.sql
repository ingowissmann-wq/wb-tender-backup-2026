BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:critical-region-portal-resolution:160',0));

-- A participation target is not the publication source. Only explicit current
-- enrichment mappings or evidenced procurement/submission links may select a
-- portal; TED notice/login links can therefore never shadow the bidder portal.
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
  JOIN tender.enrichment_documents document ON document.enrichment_version_id=current.id
  WHERE nullif(document.provenance->>'portalId','') IS NOT NULL
), evidenced_targets AS (
  SELECT DISTINCT link.tender_id,portal.id::text portal_key
  FROM tender.tender_external_links link
  JOIN tender.portal_registry portal ON (
    lower(trim(trailing '.' from coalesce(nullif(link.final_host,''),link.original_host)))=lower(trim(trailing '.' from portal.canonical_domain))
    OR lower(trim(trailing '.' from coalesce(nullif(link.final_host,''),link.original_host)))=ANY(coalesce(portal.authentication_domains,'{}'::text[]))
  )
  WHERE link.role IN('PROCUREMENT_DOCUMENT','SUBMISSION')
    AND link.verification_status IN('HTTP_VERIFIED','LOGIN_REQUIRED','MFA_REQUIRED')
    AND coalesce(link.evidence->>'submissionPortal','true')<>'false'
), candidates AS (
  SELECT * FROM explicit_profiles UNION SELECT * FROM evidenced_targets
), mapping_count AS (
  SELECT tender_id,count(DISTINCT portal_key)::int portal_mapping_count,min(portal_key) portal_key
  FROM candidates GROUP BY tender_id
)
SELECT mapping.tender_id,CASE WHEN mapping.portal_mapping_count=1 THEN portal.id END portal_id,
       mapping.portal_mapping_count,
       CASE WHEN mapping.portal_mapping_count<>1 THEN 'AMBIGUOUS'
            WHEN portal.id IS NULL THEN 'UNKNOWN_PROFILE' ELSE 'UNIQUE_CANONICAL_PROFILE' END mapping_status
FROM mapping_count mapping LEFT JOIN tender.portal_registry portal ON portal.id::text=mapping.portal_key;

-- Existing encrypted credentials and active sessions remain untouched. Legacy
-- credentials remain usable only when the exact company/portal binding is unique;
-- ambiguous credentials disappear from this action view and are shown as review.
CREATE OR REPLACE VIEW tender.current_registered_tender_company_portals
WITH (security_barrier=true) AS
WITH active_bindings AS (
  SELECT credential.portal_id,scope.company_id,count(DISTINCT credential.id)::int active_credential_count,
         min(credential.id::text)::uuid credential_id
  FROM tender.portal_credential_secrets credential
  JOIN tender.portal_credential_companies scope ON scope.credential_id=credential.id AND scope.active=true
  JOIN tender.enterprise_company_links company ON company.company_id=scope.company_id AND company.active=true
  JOIN tender.portal_registry portal ON portal.id=credential.portal_id
  WHERE credential.status='ACTIVE' AND credential.revoked_at IS NULL
    AND (credential.valid_until IS NULL OR credential.valid_until>now())
    AND (credential.account_type IS NULL OR (
      lower(trim(trailing '.' from credential.bound_host))=lower(trim(trailing '.' from portal.canonical_domain))
      AND credential.authorized_capabilities && ARRAY['BIDDER_LOGIN','TENDER_DOCUMENT_DOWNLOAD','BID_SUBMISSION']::text[]))
  GROUP BY credential.portal_id,scope.company_id HAVING count(DISTINCT credential.id)=1
)
SELECT mapping.tender_id,mapping.portal_id,binding.company_id,binding.credential_id,
       binding.active_credential_count,mapping.mapping_status
FROM tender.current_tender_portal_mapping_truth mapping
JOIN active_bindings binding ON binding.portal_id=mapping.portal_id
WHERE mapping.mapping_status='UNIQUE_CANONICAL_PROFILE';

COMMENT ON VIEW tender.current_registered_tender_company_portals IS
 'Tenant/RLS-visible exact company credential scope. Unique legacy bindings are preserved; publication sources and ambiguous portal or credential candidates fail closed.';

INSERT INTO app.schema_migrations(version,description)
VALUES('0160-critical-region-portal-resolution','Restore exact region materialization lookup and evidence-bound company portal credential resolution')
ON CONFLICT(version) DO NOTHING;
COMMIT;
