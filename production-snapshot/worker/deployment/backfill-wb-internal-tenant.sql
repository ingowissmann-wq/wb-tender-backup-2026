-- Green only. Required transaction-local inputs (set by an authorized operator):
--   app.tenant_id                dedicated WB internal tenant UUID
--   app.wb_tenant_display_name   approved existing organization display name
--   app.wb_identity_hash         non-secret stable internal identity hash
--   app.wb_expected_companies    asserted active+inactive company row count
--   app.wb_source_fingerprint    immutable backup/source fingerprint
--   app.wb_backfill_run_id       unique UUID for this run
-- No company or tender business row is copied or modified by this phase.
BEGIN;

DO $$
DECLARE expected integer; actual integer; tenant uuid; run_id uuid;
BEGIN
  tenant := nullif(current_setting('app.tenant_id',true),'')::uuid;
  run_id := nullif(current_setting('app.wb_backfill_run_id',true),'')::uuid;
  expected := nullif(current_setting('app.wb_expected_companies',true),'')::integer;
  SELECT count(*)::integer INTO actual FROM tender.enterprise_company_links;
  IF tenant IS NULL OR run_id IS NULL THEN RAISE EXCEPTION 'wb_backfill_identifiers_required'; END IF;
  IF length(nullif(current_setting('app.wb_tenant_display_name',true),''))<2 THEN RAISE EXCEPTION 'wb_display_name_required'; END IF;
  IF length(nullif(current_setting('app.wb_identity_hash',true),''))<32 THEN RAISE EXCEPTION 'wb_identity_hash_required'; END IF;
  IF length(nullif(current_setting('app.wb_source_fingerprint',true),''))<32 THEN RAISE EXCEPTION 'wb_source_fingerprint_required'; END IF;
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'wb_company_count_assertion_failed expected %, actual %',expected,actual; END IF;
  IF EXISTS(SELECT 1 FROM saas.legacy_company_tenant_bindings) THEN RAISE EXCEPTION 'legacy_company_bindings_already_exist'; END IF;
END $$;

INSERT INTO saas.tenants(id,slug,display_name,status,customer_identity_hash,tenant_kind)
VALUES(
  current_setting('app.tenant_id')::uuid,
  'wb-internal',
  current_setting('app.wb_tenant_display_name'),
  'ACTIVE',
  current_setting('app.wb_identity_hash'),
  'INTERNAL'
);

INSERT INTO saas.legacy_company_tenant_bindings(company_id,tenant_id,backfill_run_id)
SELECT company_id,current_setting('app.tenant_id')::uuid,current_setting('app.wb_backfill_run_id')::uuid
FROM tender.enterprise_company_links;

INSERT INTO saas.tenant_backfill_runs(id,tenant_id,expected_company_count,actual_company_count,source_fingerprint,executed_by)
SELECT current_setting('app.wb_backfill_run_id')::uuid,current_setting('app.tenant_id')::uuid,
       current_setting('app.wb_expected_companies')::integer,count(*)::integer,
       current_setting('app.wb_source_fingerprint'),session_user
FROM saas.legacy_company_tenant_bindings
WHERE tenant_id=current_setting('app.tenant_id')::uuid;

DO $$
DECLARE expected integer; bound integer;
BEGIN
  expected := current_setting('app.wb_expected_companies')::integer;
  SELECT count(*)::integer INTO bound FROM saas.legacy_company_tenant_bindings
   WHERE tenant_id=current_setting('app.tenant_id')::uuid;
  IF bound IS DISTINCT FROM expected THEN RAISE EXCEPTION 'wb_binding_postcondition_failed'; END IF;
END $$;

COMMIT;
