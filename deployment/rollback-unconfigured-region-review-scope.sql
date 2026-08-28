BEGIN;
CREATE OR REPLACE VIEW tender.current_scoped_region_evaluations AS
SELECT DISTINCT ON(evaluation.tender_id,evaluation.company_id,evaluation.lot_id,scope.canonical_service)
 evaluation.*,scope.tenant_id active_tenant_id,scope.canonical_service active_canonical_service,scope.profile_id active_profile_id,
 scope.active_region_version_id active_region_profile_version_id,active.version_id active_configuration_version_id
FROM tender.configuration_scopes scope
JOIN tender.configuration_active_parameters active ON active.company_id=scope.company_id AND active.parameter_key='A08'
 AND (CASE active.service_line WHEN 'facility-management' THEN 'facility_management' WHEN 'emergency-services' THEN 'emergency_services' ELSE active.service_line END)=scope.canonical_service
JOIN tender.region_evaluations evaluation ON evaluation.company_id=scope.company_id AND evaluation.configuration_version_id=active.version_id
 AND (scope.active_region_version_id IS NULL OR evaluation.region_profile_version_id=scope.active_region_version_id)
 AND (evaluation.tenant_id IS NULL OR evaluation.tenant_id=scope.tenant_id)
 AND (evaluation.canonical_service IS NULL OR evaluation.canonical_service=scope.canonical_service)
 AND (evaluation.profile_id IS NULL OR evaluation.profile_id=scope.profile_id)
ORDER BY evaluation.tender_id,evaluation.company_id,evaluation.lot_id,scope.canonical_service,evaluation.evaluation_version DESC;
COMMIT;
