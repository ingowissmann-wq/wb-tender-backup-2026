BEGIN;

-- Context bindings are intentionally version-scoped.  The older manifest key
-- omitted enrichment_version_id and therefore suppressed a valid binding when
-- two immutable enrichment versions shared the same authoritative payload.
ALTER TABLE tender.enrichment_context_bindings
  DROP CONSTRAINT IF EXISTS enrichment_context_bindings_tenant_id_company_id_tender_ver_key;

CREATE UNIQUE INDEX IF NOT EXISTS enrichment_context_bindings_version_manifest_key
  ON tender.enrichment_context_bindings
    (enrichment_version_id,tenant_id,company_id,tender_version_id,lot_id,source_manifest_sha256);

COMMIT;
