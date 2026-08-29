BEGIN;

DROP INDEX IF EXISTS tender.enrichment_context_bindings_version_manifest_key;

ALTER TABLE tender.enrichment_context_bindings
  ADD CONSTRAINT enrichment_context_bindings_tenant_id_company_id_tender_ver_key
  UNIQUE (tenant_id,company_id,tender_version_id,lot_id,source_manifest_sha256);

COMMIT;
