BEGIN;

INSERT INTO tender.portal_registry(id,display_name,canonical_domain,adapter_id,adapter_version,
  adapter_validation_status,adapter_enabled,capabilities)
VALUES('00000000-0000-4000-8000-000000001260','Context 126 Portal','context-126.example',
  'context-126','1.0.0','PRODUCTION_VALIDATED',true,
  ARRAY['AUTHENTICATED_DOCUMENT_ACCESS','TENDER_DOCUMENT_DOWNLOAD','BID_SUBMISSION']::text[]);

INSERT INTO tender.tender_portal_assignments(tenant_id,company_id,tender_id,tender_version_id,
  lot_id,source_lot_id,canonical_service,portal_id,exact_host,portal_role,assignment_source,
  evidence_sha256,status)
SELECT '00000000-0000-4000-8000-000000001250','00000000-0000-4000-8000-000000001252',
  '00000000-0000-4000-8000-000000001231','00000000-0000-4000-8000-000000001255',
  lot.id,'LOT-STAGING-1','security','00000000-0000-4000-8000-000000001260',
  'context-126.example','DOCUMENT_PORTAL','MANUAL_AUDITED',repeat('d',64),'ACTIVE'
FROM tender.lots lot WHERE lot.tender_id='00000000-0000-4000-8000-000000001231'
  AND lot.external_id='LOT-STAGING-1';

CREATE ROLE context126_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA tender,saas TO context126_runtime;
GRANT SELECT ON tender.current_tender_company_portal_role_scopes,
  tender.tender_portal_assignments,tender.enterprise_company_links,tender.portal_registry,
  tender.tender_versions,tender.lots,tender.portal_credential_secrets,
  tender.portal_credential_companies TO context126_runtime;
GRANT SELECT ON saas.legacy_company_tenant_bindings TO context126_runtime;
GRANT EXECUTE ON FUNCTION tender.runtime_uuid_list(text),tender.runtime_tenant_allowed(uuid),
  tender.runtime_company_allowed(uuid) TO context126_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA saas TO context126_runtime;

SET ROLE context126_runtime;
SELECT set_config('app.tenant_ids','00000000-0000-4000-8000-000000001250',true);
SELECT set_config('app.tenant_id','00000000-0000-4000-8000-000000001250',true);
SELECT set_config('app.company_ids','00000000-0000-4000-8000-000000001252',true);

DO $$
BEGIN
  IF (SELECT count(*) FROM tender.current_tender_company_portal_role_scopes
    WHERE tender_id='00000000-0000-4000-8000-000000001231')<>1 THEN
    RAISE EXCEPTION 'exact_runtime_scope_cannot_read_its_assignment';
  END IF;
END $$;

SELECT set_config('app.tenant_ids','00000000-0000-4000-8000-000000009999',true);
SELECT set_config('app.tenant_id','00000000-0000-4000-8000-000000009999',true);
SELECT set_config('app.company_ids','00000000-0000-4000-8000-000000009999',true);

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM tender.current_tender_company_portal_role_scopes) THEN
    RAISE EXCEPTION 'cross_tenant_assignment_visible_through_view';
  END IF;
END $$;

RESET ROLE;
ROLLBACK;
