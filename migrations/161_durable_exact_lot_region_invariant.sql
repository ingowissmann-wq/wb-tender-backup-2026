BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:migration:161-durable-exact-lot-region',0));

CREATE INDEX IF NOT EXISTS service_relevance_global_region_recalc_idx
ON tender.service_relevance_evaluations(company_id,tender_id,lot_key,evaluation_version DESC)
WHERE primary_company=true AND relevance_status='RELEVANT' AND service_scope_gate='PASSED';

CREATE INDEX IF NOT EXISTS tender_lot_lifecycles_eligible_lookup_idx
ON tender.tender_lot_lifecycles(tender_id,lot_key,offer_deadline)
WHERE is_current=true AND lifecycle_status='ACTIVE'
  AND participation_status='ELIGIBLE' AND deadline_quality='EXACT';

CREATE OR REPLACE FUNCTION tender.enqueue_region_recalculation_for_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=tender,pg_temp
AS $$
DECLARE active_region tender.region_profile_versions%ROWTYPE;
BEGIN
  IF NEW.active_region_version_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO active_region
  FROM tender.region_profile_versions
  WHERE id=NEW.active_region_version_id
    AND tenant_id=NEW.tenant_id
    AND company_id=NEW.company_id
    AND canonical_service=NEW.canonical_service
    AND profile_id=NEW.profile_id
    AND status='ACTIVE';
  IF NOT FOUND THEN RETURN NEW; END IF;
  INSERT INTO tender.region_recalculation_jobs(
    tenant_id,company_id,canonical_service,profile_id,
    configuration_version_id,region_profile_version_id,status,idempotency_key
  ) VALUES(
    NEW.tenant_id,NEW.company_id,NEW.canonical_service,NEW.profile_id,
    active_region.configuration_version_id,active_region.id,'QUEUED',
    'scope-region-v2:'||NEW.tenant_id::text||':'||NEW.company_id::text||':'||
    NEW.canonical_service||':'||NEW.profile_id::text||':'||active_region.id::text
  ) ON CONFLICT(idempotency_key) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS configuration_scope_region_recalculation
ON tender.configuration_scopes;
CREATE TRIGGER configuration_scope_region_recalculation
AFTER INSERT OR UPDATE OF active_region_version_id
ON tender.configuration_scopes
FOR EACH ROW
WHEN (NEW.active_region_version_id IS NOT NULL)
EXECUTE FUNCTION tender.enqueue_region_recalculation_for_scope();

INSERT INTO tender.region_recalculation_jobs(
 tenant_id,company_id,canonical_service,profile_id,configuration_version_id,
 region_profile_version_id,status,idempotency_key
)
SELECT scope.tenant_id,scope.company_id,scope.canonical_service,scope.profile_id,
 active_region.configuration_version_id,active_region.id,'QUEUED',
 'migration-0161-durable-exact-lot-region:'||scope.tenant_id::text||':'||
 scope.company_id::text||':'||scope.canonical_service||':'||
 scope.profile_id::text||':'||active_region.id::text
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
VALUES('0161-durable-exact-lot-region-invariant',
 'Persist performance indexes, queue future scope changes, rematerialize every selected lot and fail closed on incomplete bindings')
ON CONFLICT(version) DO NOTHING;
COMMIT;
