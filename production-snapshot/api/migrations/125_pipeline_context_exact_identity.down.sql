BEGIN;

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';

DROP TRIGGER IF EXISTS pipeline_context_exact_identity ON tender.pipeline_contexts;
DROP FUNCTION IF EXISTS tender.bind_pipeline_context_exact_identity();
ALTER TABLE tender.pipeline_contexts ALTER COLUMN tenant_id DROP NOT NULL;

DROP POLICY IF EXISTS runtime_bound_scope ON tender.pipeline_contexts;
CREATE POLICY runtime_bound_scope ON tender.pipeline_contexts
USING(tender.runtime_company_allowed(company_id) AND EXISTS(
  SELECT 1 FROM saas.legacy_company_tenant_bindings runtime_binding
  WHERE runtime_binding.company_id=pipeline_contexts.company_id
    AND tender.runtime_tenant_allowed(runtime_binding.tenant_id)
))
WITH CHECK(tender.runtime_company_allowed(company_id) AND EXISTS(
  SELECT 1 FROM saas.legacy_company_tenant_bindings runtime_binding
  WHERE runtime_binding.company_id=pipeline_contexts.company_id
    AND tender.runtime_tenant_allowed(runtime_binding.tenant_id)
));

DELETE FROM app.schema_migrations WHERE version='0125-pipeline-context-exact-identity';

-- Additive identity columns and all backfilled values are deliberately retained.

COMMIT;
