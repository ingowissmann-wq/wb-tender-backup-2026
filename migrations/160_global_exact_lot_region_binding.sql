BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:migration:160-global-exact-lot-region',0));

INSERT INTO tender.region_recalculation_jobs(
 tenant_id,company_id,canonical_service,profile_id,configuration_version_id,
 region_profile_version_id,status,idempotency_key
)
SELECT scope.tenant_id,scope.company_id,scope.canonical_service,scope.profile_id,
 active_region.configuration_version_id,active_region.id,'QUEUED',
 'migration-0160-global-exact-lot-region:'||scope.tenant_id::text||':'||
 scope.company_id::text||':'||scope.canonical_service||':'||scope.profile_id::text||':'||active_region.id::text
FROM tender.configuration_scopes scope
JOIN tender.region_profile_versions active_region
 ON active_region.id=scope.active_region_version_id
 AND active_region.tenant_id=scope.tenant_id
 AND active_region.company_id=scope.company_id
 AND active_region.canonical_service=scope.canonical_service
 AND active_region.profile_id=scope.profile_id
 AND active_region.status='ACTIVE'
ON CONFLICT(idempotency_key) DO NOTHING;

INSERT INTO app.schema_migrations(version,description)
VALUES('0160-global-exact-lot-region-binding','Queue global append-only exact lot region rematerialization and selection refresh')
ON CONFLICT(version) DO NOTHING;
COMMIT;
