BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:migration:162-selected-lot-region-invariant',0));

CREATE OR REPLACE FUNCTION tender.enqueue_region_recalculation_for_lot_selection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=tender,pg_temp
AS $$
DECLARE
  selected_scope tender.configuration_scopes%ROWTYPE;
  active_region tender.region_profile_versions%ROWTYPE;
BEGIN
  SELECT * INTO selected_scope
  FROM tender.configuration_scopes
  WHERE tenant_id=NEW.tenant_id
    AND company_id=NEW.company_id
    AND canonical_service=NEW.canonical_service
    AND active_region_version_id IS NOT NULL
  ORDER BY updated_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  SELECT * INTO active_region
  FROM tender.region_profile_versions
  WHERE id=selected_scope.active_region_version_id
    AND tenant_id=selected_scope.tenant_id
    AND company_id=selected_scope.company_id
    AND canonical_service=selected_scope.canonical_service
    AND profile_id=selected_scope.profile_id
    AND status='ACTIVE';

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  INSERT INTO tender.region_recalculation_jobs(
    tenant_id,
    company_id,
    canonical_service,
    profile_id,
    configuration_version_id,
    region_profile_version_id,
    status,
    idempotency_key
  )
  VALUES(
    selected_scope.tenant_id,
    selected_scope.company_id,
    selected_scope.canonical_service,
    selected_scope.profile_id,
    active_region.configuration_version_id,
    active_region.id,
    'QUEUED',
    'selected-lot-region-v1:'||
      selected_scope.tenant_id::text||':'||
      selected_scope.company_id::text||':'||
      selected_scope.canonical_service||':'||
      selected_scope.profile_id::text||':'||
      active_region.id::text||':'||
      NEW.tender_id::text||':'||
      NEW.lot_id::text
  )
  ON CONFLICT(idempotency_key) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tender_lot_selection_region_recalculation
ON tender.tender_lot_selections;

CREATE TRIGGER tender_lot_selection_region_recalculation
AFTER INSERT OR UPDATE OF company_id,canonical_service,lot_id,source_lot_id
ON tender.tender_lot_selections
FOR EACH ROW
EXECUTE FUNCTION tender.enqueue_region_recalculation_for_lot_selection();

INSERT INTO tender.region_recalculation_jobs(
  tenant_id,
  company_id,
  canonical_service,
  profile_id,
  configuration_version_id,
  region_profile_version_id,
  status,
  idempotency_key
)
SELECT DISTINCT
  scope.tenant_id,
  scope.company_id,
  scope.canonical_service,
  scope.profile_id,
  active_region.configuration_version_id,
  active_region.id,
  'QUEUED',
  'migration-0162-selected-lot-region:'||
    scope.tenant_id::text||':'||
    scope.company_id::text||':'||
    scope.canonical_service||':'||
    scope.profile_id::text||':'||
    active_region.id::text
FROM tender.configuration_scopes scope
JOIN tender.region_profile_versions active_region
  ON active_region.id=scope.active_region_version_id
 AND active_region.tenant_id=scope.tenant_id
 AND active_region.company_id=scope.company_id
 AND active_region.canonical_service=scope.canonical_service
 AND active_region.profile_id=scope.profile_id
 AND active_region.status='ACTIVE'
WHERE EXISTS(
  SELECT 1
  FROM tender.tender_lot_selections selection
  LEFT JOIN tender.current_scoped_region_evaluations evaluation
    ON evaluation.id=selection.region_evaluation_id
   AND evaluation.tender_id=selection.tender_id
   AND evaluation.lot_id=selection.lot_id
   AND evaluation.company_id=selection.company_id
   AND evaluation.canonical_service=selection.canonical_service
  WHERE selection.tenant_id=scope.tenant_id
    AND selection.company_id=scope.company_id
    AND selection.canonical_service=scope.canonical_service
    AND evaluation.id IS NULL
)
ON CONFLICT(idempotency_key) DO NOTHING;

INSERT INTO app.schema_migrations(version,description)
VALUES(
  '0162-selected-lot-region-invariant',
  'Rematerialize persisted selected lots independently of discovery gates and queue future lot selections'
)
ON CONFLICT(version) DO NOTHING;

COMMIT;
