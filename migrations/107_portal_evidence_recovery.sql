BEGIN;

CREATE TABLE IF NOT EXISTS tender.tender_portal_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tender.tenders(id),
  tender_version_id uuid NOT NULL REFERENCES tender.tender_versions(id),
  portal_id uuid REFERENCES tender.portal_registry(id),
  exact_host text,
  evidence_url text CHECK (evidence_url IS NULL OR evidence_url ~ '^https://'),
  evidence_role text,
  evidence_priority integer,
  resolution_status text NOT NULL CHECK (resolution_status IN ('UNIQUE_EVIDENCE','REVIEW_REQUIRED','NOT_FOUND')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_sha256 character(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tender_version_id)
);

CREATE INDEX IF NOT EXISTS tender_portal_resolutions_tender_status_idx
  ON tender.tender_portal_resolutions(tender_id,resolution_status,updated_at DESC);

CREATE TABLE IF NOT EXISTS tender.tender_portal_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  tender_id uuid NOT NULL REFERENCES tender.tenders(id),
  tender_version_id uuid NOT NULL REFERENCES tender.tender_versions(id),
  lot_id uuid REFERENCES tender.lots(id),
  source_lot_id text,
  canonical_service text NOT NULL,
  portal_id uuid NOT NULL REFERENCES tender.portal_registry(id),
  exact_host text NOT NULL,
  assignment_source text NOT NULL CHECK (assignment_source IN ('MANUAL_AUDITED','UNIQUE_EVIDENCE')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUPERSEDED')),
  evidence_sha256 character(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  assigned_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz
);

ALTER TABLE tender.tender_portal_assignments ADD COLUMN IF NOT EXISTS canonical_service text;
ALTER TABLE tender.tender_portal_assignments ALTER COLUMN canonical_service SET NOT NULL;
DROP INDEX IF EXISTS tender.tender_portal_assignments_active_scope_uq;
CREATE UNIQUE INDEX tender_portal_assignments_active_scope_uq
  ON tender.tender_portal_assignments(tenant_id,company_id,tender_id,canonical_service,coalesce(source_lot_id,'')) WHERE status='ACTIVE';

CREATE OR REPLACE VIEW tender.current_tender_portal_mapping_truth AS
WITH latest_version AS (
  SELECT DISTINCT ON (version.tender_id) version.id,version.tender_id
  FROM tender.tender_versions version
  ORDER BY version.tender_id,version.version DESC,version.created_at DESC,version.id DESC
), current_enrichment AS (
  SELECT DISTINCT ON (version.tender_id) version.id,version.tender_id
  FROM tender.enrichment_versions version
  WHERE version.historical=false
  ORDER BY version.tender_id,version.version DESC,version.created_at DESC,version.id DESC
), explicit_profiles AS (
  SELECT current.tender_id,NULLIF(document.provenance->>'portalId','') portal_key
  FROM current_enrichment current
  JOIN tender.enrichment_documents document ON document.enrichment_version_id=current.id
  WHERE NULLIF(document.provenance->>'portalId','') IS NOT NULL
  UNION ALL
  SELECT resolution.tender_id,resolution.portal_id::text portal_key
  FROM tender.tender_portal_resolutions resolution
  JOIN latest_version ON latest_version.tender_id=resolution.tender_id AND latest_version.id=resolution.tender_version_id
  WHERE resolution.resolution_status='UNIQUE_EVIDENCE' AND resolution.portal_id IS NOT NULL
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

COMMIT;
