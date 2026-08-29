BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='15min';

INSERT INTO tender.context_backfill_runs(release_id,before_counts,external_submission_enabled)
VALUES('20260825-authoritative-portal-assignment-backfill-129.1',jsonb_build_object(
  'active_portal_assignments',(SELECT count(*) FROM tender.tender_portal_assignments WHERE status='ACTIVE'),
  'physical_deletes',0
),false)
ON CONFLICT(release_id) DO NOTHING;

-- A tender version can authoritatively name different document, bidder and
-- submission portals. The former version-only uniqueness collapsed those
-- roles and made correct role separation impossible.
ALTER TABLE tender.tender_portal_resolutions
  DROP CONSTRAINT IF EXISTS tender_portal_resolutions_tender_version_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS tender_portal_resolutions_version_role_uq
  ON tender.tender_portal_resolutions(tender_version_id,coalesce(evidence_role,''));

-- Materialize only an already explicit company/lot choice combined with one
-- authoritative portal resolution for the exact current tender version.
-- Publication, document and submission roles are never inferred from each
-- other. No credential or external capability is synthesized.
WITH candidates AS(
  SELECT selection.tenant_id,selection.company_id,selection.tender_id,
    selection.tender_version_id,selection.lot_id,selection.source_lot_id,
    selection.canonical_service,resolution.portal_id,lower(resolution.exact_host) exact_host,
    CASE resolution.evidence_role
      WHEN 'PARTICIPATION' THEN 'BIDDER_PORTAL'
      WHEN 'PROCUREMENT_DOCUMENT' THEN 'DOCUMENT_PORTAL'
      WHEN 'SUBMISSION' THEN 'SUBMISSION_PORTAL'
    END portal_role,resolution.evidence_sha256,
    count(*) OVER(PARTITION BY selection.tenant_id,selection.company_id,selection.tender_id,
      selection.canonical_service,selection.source_lot_id,resolution.evidence_role) candidate_count
  FROM tender.tender_lot_selections selection
  JOIN tender.tenders tender ON tender.id=selection.tender_id
    AND tender.source_lifecycle_status='ACTIVE'
  JOIN tender.enterprise_company_links company ON company.company_id=selection.company_id
    AND company.active=true
  JOIN tender.configuration_scopes scope ON scope.tenant_id=selection.tenant_id
    AND scope.company_id=selection.company_id AND scope.profile_id=company.tender_profile_id
    AND scope.canonical_service=selection.canonical_service
  JOIN saas.legacy_company_tenant_bindings tenant ON tenant.company_id=selection.company_id
    AND tenant.tenant_id=selection.tenant_id
  JOIN tender.lots lot ON lot.id=selection.lot_id AND lot.tender_id=selection.tender_id
    AND lot.external_id=selection.source_lot_id
  JOIN tender.tender_portal_resolutions resolution ON resolution.tender_id=selection.tender_id
    AND resolution.tender_version_id=selection.tender_version_id
    AND resolution.resolution_status='UNIQUE_EVIDENCE'
    AND resolution.portal_id IS NOT NULL AND resolution.exact_host IS NOT NULL
    AND resolution.evidence_role IN('PARTICIPATION','PROCUREMENT_DOCUMENT','SUBMISSION')
    AND resolution.evidence_sha256 ~ '^[0-9a-f]{64}$'
  JOIN tender.portal_registry portal ON portal.id=resolution.portal_id
    AND lower(portal.canonical_domain)=lower(resolution.exact_host)
  WHERE selection.tender_version_id=(SELECT version.id FROM tender.tender_versions version
    WHERE version.tender_id=selection.tender_id
    ORDER BY version.version DESC,version.created_at DESC,version.id DESC LIMIT 1)
)
INSERT INTO tender.tender_portal_assignments(tenant_id,company_id,tender_id,tender_version_id,
  lot_id,source_lot_id,canonical_service,portal_id,exact_host,portal_role,
  assignment_source,evidence_sha256,status)
SELECT tenant_id,company_id,tender_id,tender_version_id,lot_id,source_lot_id,
  canonical_service,portal_id,exact_host,portal_role,'UNIQUE_EVIDENCE',evidence_sha256,'ACTIVE'
FROM candidates candidate
WHERE candidate_count=1 AND portal_role IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM tender.tender_portal_assignments assignment
    WHERE assignment.tenant_id=candidate.tenant_id AND assignment.company_id=candidate.company_id
      AND assignment.tender_id=candidate.tender_id
      AND assignment.canonical_service=candidate.canonical_service
      AND coalesce(assignment.source_lot_id,'')=candidate.source_lot_id
      AND assignment.portal_role=candidate.portal_role AND assignment.status='ACTIVE');

UPDATE tender.context_backfill_runs
SET finished_at=now(),after_counts=jsonb_build_object(
  'active_portal_assignments',(SELECT count(*) FROM tender.tender_portal_assignments WHERE status='ACTIVE'),
  'unique_evidence_assignments',(SELECT count(*) FROM tender.tender_portal_assignments
    WHERE status='ACTIVE' AND assignment_source='UNIQUE_EVIDENCE'),
  'external_submission_enabled',false,'physical_deletes',0
)
WHERE release_id='20260825-authoritative-portal-assignment-backfill-129.1';

INSERT INTO app.schema_migrations(version,description)
VALUES('0129-authoritative-portal-assignment-backfill',
  'Materialize exact current company-lot portal roles only from explicit selection and unique version-bound evidence')
ON CONFLICT(version) DO NOTHING;

COMMIT;
