BEGIN;

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15min';

INSERT INTO tender.context_backfill_runs(release_id,before_counts,external_submission_enabled)
VALUES('20260825-role-scoped-tender-portal-assignments-126.1',jsonb_build_object(
  'portal_assignments',(SELECT count(*) FROM tender.tender_portal_assignments),
  'active_portal_assignments',(SELECT count(*) FROM tender.tender_portal_assignments WHERE status='ACTIVE'),
  'physical_deletes',0
),false)
ON CONFLICT(release_id) DO NOTHING;

ALTER TABLE tender.tender_portal_assignments
  ADD COLUMN IF NOT EXISTS portal_role text NOT NULL DEFAULT 'PROCUREMENT_PORTAL';

ALTER TABLE tender.tender_portal_assignments
  DROP CONSTRAINT IF EXISTS tender_portal_assignments_portal_role_check;
ALTER TABLE tender.tender_portal_assignments
  ADD CONSTRAINT tender_portal_assignments_portal_role_check CHECK(portal_role IN(
    'PROCUREMENT_PORTAL','DOCUMENT_PORTAL','BIDDER_PORTAL','SUBMISSION_PORTAL'
  ));

DROP INDEX IF EXISTS tender.tender_portal_assignments_active_scope_uq;
CREATE UNIQUE INDEX IF NOT EXISTS tender_portal_assignments_active_role_scope_uq
  ON tender.tender_portal_assignments(
    tenant_id,company_id,tender_id,canonical_service,coalesce(source_lot_id,''),portal_role
  ) WHERE status='ACTIVE';

CREATE OR REPLACE VIEW tender.current_tender_company_portal_role_scopes
WITH (security_barrier=true,security_invoker=true) AS
WITH current_assignment AS(
  SELECT assignment.*
  FROM tender.tender_portal_assignments assignment
  JOIN tender.enterprise_company_links company
    ON company.company_id=assignment.company_id AND company.active=true
  JOIN saas.legacy_company_tenant_bindings company_tenant
    ON company_tenant.company_id=assignment.company_id AND company_tenant.tenant_id=assignment.tenant_id
  JOIN tender.portal_registry portal ON portal.id=assignment.portal_id
    AND lower(portal.canonical_domain)=lower(assignment.exact_host)
  JOIN LATERAL(
    SELECT version.id FROM tender.tender_versions version
    WHERE version.tender_id=assignment.tender_id
    ORDER BY version.version DESC,version.created_at DESC,version.id DESC LIMIT 1
  ) latest_version ON latest_version.id=assignment.tender_version_id
  LEFT JOIN tender.lots lot ON lot.id=assignment.lot_id
    AND lot.tender_id=assignment.tender_id AND lot.external_id=assignment.source_lot_id
  WHERE assignment.status='ACTIVE'
    AND ((assignment.lot_id IS NULL AND assignment.source_lot_id IS NULL)
      OR lot.id IS NOT NULL)
), capable_credentials AS(
  SELECT assignment.id assignment_id,
    count(DISTINCT credential.id)::int active_credential_count,
    min(credential.id::text)::uuid credential_id
  FROM current_assignment assignment
  JOIN tender.portal_credential_secrets credential
    ON credential.portal_id=assignment.portal_id AND credential.status='ACTIVE'
    AND credential.revoked_at IS NULL
    AND (credential.valid_until IS NULL OR credential.valid_until>now())
    AND credential.bound_host=lower(assignment.exact_host)
    AND CASE assignment.portal_role
      WHEN 'DOCUMENT_PORTAL' THEN credential.authorized_capabilities && ARRAY[
        'AUTHENTICATED_DOCUMENT_ACCESS','TENDER_DOCUMENT_DOWNLOAD'
      ]::text[]
      WHEN 'SUBMISSION_PORTAL' THEN 'BID_SUBMISSION'=ANY(coalesce(credential.authorized_capabilities,'{}'::text[]))
      WHEN 'BIDDER_PORTAL' THEN 'BIDDER_LOGIN'=ANY(coalesce(credential.authorized_capabilities,'{}'::text[]))
      ELSE credential.authorized_capabilities && ARRAY[
        'BIDDER_LOGIN','TENDER_DOCUMENT_DOWNLOAD','BID_SUBMISSION'
      ]::text[]
    END
  JOIN tender.portal_credential_companies company_scope
    ON company_scope.credential_id=credential.id AND company_scope.company_id=assignment.company_id
      AND company_scope.active=true
  GROUP BY assignment.id
  HAVING count(DISTINCT credential.id)=1
)
SELECT assignment.id assignment_id,assignment.tenant_id,assignment.company_id,
  assignment.tender_id,assignment.tender_version_id,assignment.lot_id,assignment.source_lot_id,
  assignment.canonical_service,assignment.portal_role,assignment.portal_id,assignment.exact_host,
  credential.credential_id,credential.active_credential_count,assignment.assignment_source,
  assignment.evidence_sha256,assignment.created_at
FROM current_assignment assignment
LEFT JOIN capable_credentials credential ON credential.assignment_id=assignment.id;

COMMENT ON VIEW tender.current_tender_company_portal_role_scopes IS
  'Exact current company, tender version, lot, portal role, host and optional single capable credential. Missing credentials remain visible but fail closed.';

UPDATE tender.context_backfill_runs
SET finished_at=now(),after_counts=jsonb_build_object(
  'portal_assignments',(SELECT count(*) FROM tender.tender_portal_assignments),
  'active_portal_assignments',(SELECT count(*) FROM tender.tender_portal_assignments WHERE status='ACTIVE'),
  'role_scoped_assignments',(SELECT count(*) FROM tender.tender_portal_assignments WHERE portal_role IS NOT NULL),
  'external_submission_enabled',false,
  'physical_deletes',0
)
WHERE release_id='20260825-role-scoped-tender-portal-assignments-126.1';

INSERT INTO app.schema_migrations(version,description)
VALUES('0126-role-scoped-tender-portal-assignments',
  'Persist exact document, bidder and submission portal roles per tenant, company, tender version and canonical lot')
ON CONFLICT(version) DO NOTHING;

COMMIT;
