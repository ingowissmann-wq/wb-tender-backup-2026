BEGIN;

CREATE OR REPLACE VIEW tender.current_tender_portal_mapping_truth AS
WITH current_enrichment AS (
  SELECT DISTINCT ON (version.tender_id) version.id,version.tender_id
  FROM tender.enrichment_versions version
  WHERE version.historical=false
  ORDER BY version.tender_id,version.version DESC,version.created_at DESC,version.id DESC
), explicit_profiles AS (
  SELECT current.tender_id,NULLIF(document.provenance->>'portalId','') portal_key
  FROM current_enrichment current
  JOIN tender.enrichment_documents document ON document.enrichment_version_id=current.id
  WHERE NULLIF(document.provenance->>'portalId','') IS NOT NULL
), mapping_count AS (
  SELECT tender_id,count(DISTINCT portal_key)::integer portal_mapping_count,min(portal_key) portal_key
  FROM explicit_profiles GROUP BY tender_id
)
SELECT mapping.tender_id,
  CASE WHEN mapping.portal_mapping_count=1 THEN portal.id ELSE NULL::uuid END portal_id,
  mapping.portal_mapping_count,
  CASE WHEN mapping.portal_mapping_count<>1 THEN 'AMBIGUOUS'
       WHEN portal.id IS NULL THEN 'UNKNOWN_PROFILE'
       ELSE 'UNIQUE_CANONICAL_PROFILE' END mapping_status
FROM mapping_count mapping
LEFT JOIN tender.portal_registry portal ON portal.id::text=mapping.portal_key;

DROP TABLE IF EXISTS tender.tender_portal_assignments;
DROP TABLE IF EXISTS tender.tender_portal_resolutions;

COMMIT;
