BEGIN;
SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='10min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:superseded-relevance-context:149',0));

ALTER TABLE tender.pipeline_contexts DROP CONSTRAINT IF EXISTS pipeline_contexts_integrity_status_check;
ALTER TABLE tender.pipeline_contexts ADD CONSTRAINT pipeline_contexts_integrity_status_check CHECK(context_integrity_status IN(
  'CANONICAL','TENDER_GLOBAL','HISTORICAL_SOURCE','REPAIR_REQUIRED','SUPERSEDED_RELEVANCE'
));

CREATE OR REPLACE FUNCTION tender.bind_pipeline_context_exact_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tender,saas AS $$
DECLARE lifecycle_status text; relevance_superseded boolean:=false;
BEGIN
  SELECT binding.tenant_id INTO NEW.tenant_id FROM saas.legacy_company_tenant_bindings binding WHERE binding.company_id=NEW.company_id;
  IF coalesce(NEW.lot_key,'')<>'' THEN
    SELECT lot.id INTO NEW.lot_id FROM tender.lots lot WHERE lot.tender_id=NEW.tender_id AND lot.external_id=NEW.lot_key;
    SELECT binding.enrichment_version_id INTO NEW.enrichment_version_id
    FROM tender.enrichment_context_bindings binding JOIN tender.enrichment_versions enrichment
      ON enrichment.id=binding.enrichment_version_id AND enrichment.historical=false
    WHERE binding.tenant_id=NEW.tenant_id AND binding.company_id=NEW.company_id
      AND binding.tender_id=NEW.tender_id AND binding.source_lot_id=NEW.lot_key AND binding.lot_id=NEW.lot_id
    ORDER BY enrichment.version DESC,binding.created_at DESC LIMIT 1;
    SELECT EXISTS(SELECT 1 FROM tender.current_service_relevance relevance
      WHERE relevance.tender_id=NEW.tender_id AND relevance.company_id=NEW.company_id
        AND relevance.lot_key=NEW.lot_key
        AND (relevance.relevance_status IN('EXCLUDED','NOT_APPLICABLE')
          OR relevance.service_scope_gate<>'PASSED' OR relevance.primary_company=false))
      AND NOT EXISTS(SELECT 1 FROM tender.tender_lot_selections selection
        WHERE selection.tenant_id=NEW.tenant_id AND selection.company_id=NEW.company_id
          AND selection.tender_id=NEW.tender_id AND selection.source_lot_id=NEW.lot_key
          AND selection.lot_id=NEW.lot_id)
    INTO relevance_superseded;
  ELSE
    NEW.lot_id:=NULL;
    SELECT enrichment.id INTO NEW.enrichment_version_id FROM tender.enrichment_versions enrichment
    WHERE enrichment.tender_id=NEW.tender_id AND enrichment.historical=false
    ORDER BY enrichment.version DESC,enrichment.created_at DESC LIMIT 1;
  END IF;
  SELECT source_lifecycle_status INTO lifecycle_status FROM tender.tenders WHERE id=NEW.tender_id;
  IF lifecycle_status IS DISTINCT FROM 'ACTIVE' THEN
    NEW.context_integrity_status:='HISTORICAL_SOURCE'; NEW.context_integrity_reason:='SOURCE_LIFECYCLE_NOT_ACTIVE';
  ELSIF NEW.tenant_id IS NULL THEN
    NEW.context_integrity_status:='REPAIR_REQUIRED'; NEW.context_integrity_reason:='TENANT_BINDING_MISSING';
  ELSIF relevance_superseded THEN
    NEW.context_integrity_status:='SUPERSEDED_RELEVANCE'; NEW.context_integrity_reason:='CURRENT_RELEVANCE_EXCLUDES_CONTEXT';
  ELSIF coalesce(NEW.lot_key,'')='' AND NEW.enrichment_version_id IS NOT NULL THEN
    NEW.context_integrity_status:='TENDER_GLOBAL'; NEW.context_integrity_reason:=NULL;
  ELSIF coalesce(NEW.lot_key,'')='' THEN
    NEW.context_integrity_status:='REPAIR_REQUIRED'; NEW.context_integrity_reason:='CURRENT_ENRICHMENT_MISSING';
  ELSIF NEW.lot_id IS NULL THEN
    NEW.context_integrity_status:='REPAIR_REQUIRED'; NEW.context_integrity_reason:='CANONICAL_LOT_MISSING';
  ELSIF NEW.enrichment_version_id IS NULL THEN
    NEW.context_integrity_status:='REPAIR_REQUIRED'; NEW.context_integrity_reason:='EXACT_ENRICHMENT_BINDING_MISSING';
  ELSE NEW.context_integrity_status:='CANONICAL'; NEW.context_integrity_reason:=NULL;
  END IF;
  RETURN NEW;
END; $$;

WITH changed AS(
  UPDATE tender.pipeline_contexts context SET company_id=context.company_id
  WHERE context.lot_key<>'' AND EXISTS(SELECT 1 FROM tender.current_service_relevance relevance
    WHERE relevance.tender_id=context.tender_id AND relevance.company_id=context.company_id
      AND relevance.lot_key=context.lot_key
      AND (relevance.relevance_status IN('EXCLUDED','NOT_APPLICABLE')
        OR relevance.service_scope_gate<>'PASSED' OR relevance.primary_company=false))
    AND NOT EXISTS(SELECT 1 FROM tender.tender_lot_selections selection
      WHERE selection.tenant_id=context.tenant_id AND selection.company_id=context.company_id
        AND selection.tender_id=context.tender_id AND selection.source_lot_id=context.lot_key
        AND selection.lot_id=context.lot_id)
  RETURNING id,tender_id,company_id,lot_key
), evidence AS(SELECT count(*)::int affected_rows,
  encode(digest(coalesce(string_agg(id::text,',' ORDER BY id),''),'sha256'),'hex') row_fingerprint FROM changed)
INSERT INTO tender.audit_events(action,metadata)
SELECT 'SUPERSEDED_RELEVANCE_CONTEXT_TRUTH_INSTALLED',jsonb_build_object(
  'release','20260826-superseded-relevance-context-149.1','affectedRows',affected_rows,
  'rowFingerprint',row_fingerprint,'physicalDeletes',0,'externalWrite',false,
  'externalSubmission',false,'transmitted',false) FROM evidence;

INSERT INTO app.schema_migrations(version,description) VALUES(
  '0149-superseded-relevance-context-truth',
  'Distinguish current authoritative out-of-scope lot contexts from missing technical bindings')
ON CONFLICT(version) DO NOTHING;
COMMIT;
