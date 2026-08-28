BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='15min';

INSERT INTO tender.context_backfill_runs(release_id,before_counts,external_submission_enabled)
VALUES('20260825-pipeline-context-exact-identity-125.1',jsonb_build_object(
  'pipeline_contexts_total',(SELECT count(*) FROM tender.pipeline_contexts),
  'lot_scoped_without_canonical_lot_id',(SELECT count(*) FROM tender.pipeline_contexts WHERE lot_key<>''),
  'physical_deletes',0
),false)
ON CONFLICT(release_id) DO NOTHING;

ALTER TABLE tender.pipeline_contexts
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES saas.tenants(id),
  ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES tender.lots(id),
  ADD COLUMN IF NOT EXISTS enrichment_version_id uuid REFERENCES tender.enrichment_versions(id),
  ADD COLUMN IF NOT EXISTS context_integrity_status text NOT NULL DEFAULT 'REPAIR_REQUIRED',
  ADD COLUMN IF NOT EXISTS context_integrity_reason text;

ALTER TABLE tender.pipeline_contexts
  DROP CONSTRAINT IF EXISTS pipeline_contexts_integrity_status_check;
ALTER TABLE tender.pipeline_contexts
  ADD CONSTRAINT pipeline_contexts_integrity_status_check CHECK(context_integrity_status IN(
    'CANONICAL','TENDER_GLOBAL','HISTORICAL_SOURCE','REPAIR_REQUIRED'
  ));

CREATE OR REPLACE FUNCTION tender.bind_pipeline_context_exact_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,tender,saas
AS $$
DECLARE
  lifecycle_status text;
BEGIN
  SELECT binding.tenant_id INTO NEW.tenant_id
  FROM saas.legacy_company_tenant_bindings binding
  WHERE binding.company_id=NEW.company_id;

  IF coalesce(NEW.lot_key,'')<>'' THEN
    SELECT lot.id INTO NEW.lot_id FROM tender.lots lot
    WHERE lot.tender_id=NEW.tender_id AND lot.external_id=NEW.lot_key;

    SELECT binding.enrichment_version_id INTO NEW.enrichment_version_id
    FROM tender.enrichment_context_bindings binding
    JOIN tender.enrichment_versions enrichment
      ON enrichment.id=binding.enrichment_version_id AND enrichment.historical=false
    WHERE binding.tenant_id=NEW.tenant_id AND binding.company_id=NEW.company_id
      AND binding.tender_id=NEW.tender_id AND binding.source_lot_id=NEW.lot_key
      AND binding.lot_id=NEW.lot_id
    ORDER BY enrichment.version DESC,binding.created_at DESC LIMIT 1;
  ELSE
    NEW.lot_id:=NULL;
    SELECT enrichment.id INTO NEW.enrichment_version_id
    FROM tender.enrichment_versions enrichment
    WHERE enrichment.tender_id=NEW.tender_id AND enrichment.historical=false
    ORDER BY enrichment.version DESC,enrichment.created_at DESC LIMIT 1;
  END IF;

  SELECT tender.source_lifecycle_status INTO lifecycle_status
  FROM tender.tenders tender WHERE tender.id=NEW.tender_id;

  IF lifecycle_status IS DISTINCT FROM 'ACTIVE' THEN
    NEW.context_integrity_status:='HISTORICAL_SOURCE';
    NEW.context_integrity_reason:='SOURCE_LIFECYCLE_NOT_ACTIVE';
  ELSIF NEW.tenant_id IS NULL THEN
    NEW.context_integrity_status:='REPAIR_REQUIRED';
    NEW.context_integrity_reason:='TENANT_BINDING_MISSING';
  ELSIF coalesce(NEW.lot_key,'')='' AND NEW.enrichment_version_id IS NOT NULL THEN
    NEW.context_integrity_status:='TENDER_GLOBAL';
    NEW.context_integrity_reason:=NULL;
  ELSIF coalesce(NEW.lot_key,'')='' THEN
    NEW.context_integrity_status:='REPAIR_REQUIRED';
    NEW.context_integrity_reason:='CURRENT_ENRICHMENT_MISSING';
  ELSIF NEW.lot_id IS NULL THEN
    NEW.context_integrity_status:='REPAIR_REQUIRED';
    NEW.context_integrity_reason:='CANONICAL_LOT_MISSING';
  ELSIF NEW.enrichment_version_id IS NULL THEN
    NEW.context_integrity_status:='REPAIR_REQUIRED';
    NEW.context_integrity_reason:='EXACT_ENRICHMENT_BINDING_MISSING';
  ELSE
    NEW.context_integrity_status:='CANONICAL';
    NEW.context_integrity_reason:=NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pipeline_context_exact_identity ON tender.pipeline_contexts;
CREATE TRIGGER pipeline_context_exact_identity
BEFORE INSERT OR UPDATE
ON tender.pipeline_contexts
FOR EACH ROW EXECUTE FUNCTION tender.bind_pipeline_context_exact_identity();

UPDATE tender.pipeline_contexts context SET company_id=context.company_id;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM tender.pipeline_contexts WHERE tenant_id IS NULL) THEN
    RAISE EXCEPTION 'pipeline_context_tenant_backfill_incomplete';
  END IF;
END $$;

ALTER TABLE tender.pipeline_contexts ALTER COLUMN tenant_id SET NOT NULL;

DROP POLICY IF EXISTS runtime_bound_scope ON tender.pipeline_contexts;
CREATE POLICY runtime_bound_scope ON tender.pipeline_contexts
USING(tender.runtime_tenant_allowed(tenant_id) AND tender.runtime_company_allowed(company_id))
WITH CHECK(tender.runtime_tenant_allowed(tenant_id) AND tender.runtime_company_allowed(company_id));

UPDATE tender.context_backfill_runs
SET finished_at=now(),after_counts=jsonb_build_object(
  'pipeline_contexts_total',(SELECT count(*) FROM tender.pipeline_contexts),
  'canonical',(SELECT count(*) FROM tender.pipeline_contexts WHERE context_integrity_status='CANONICAL'),
  'tender_global',(SELECT count(*) FROM tender.pipeline_contexts WHERE context_integrity_status='TENDER_GLOBAL'),
  'historical_source',(SELECT count(*) FROM tender.pipeline_contexts WHERE context_integrity_status='HISTORICAL_SOURCE'),
  'repair_required',(SELECT count(*) FROM tender.pipeline_contexts WHERE context_integrity_status='REPAIR_REQUIRED'),
  'invalid_cross_tender_lot',(SELECT count(*) FROM tender.pipeline_contexts context
    JOIN tender.lots lot ON lot.id=context.lot_id WHERE lot.tender_id<>context.tender_id),
  'invalid_cross_tender_enrichment',(SELECT count(*) FROM tender.pipeline_contexts context
    JOIN tender.enrichment_versions enrichment ON enrichment.id=context.enrichment_version_id
    WHERE enrichment.tender_id<>context.tender_id),
  'external_submission_enabled',false,
  'physical_deletes',0
)
WHERE release_id='20260825-pipeline-context-exact-identity-125.1';

INSERT INTO app.schema_migrations(version,description)
VALUES('0125-pipeline-context-exact-identity',
  'Bind pipeline contexts to an exact tenant, canonical lot, and current enrichment identity without synthesizing IDs')
ON CONFLICT(version) DO NOTHING;

COMMIT;
