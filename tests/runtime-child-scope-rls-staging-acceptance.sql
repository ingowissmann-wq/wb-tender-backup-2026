\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE protected_tables(table_name text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO protected_tables VALUES
  ('approval_events'),('bid_submission_gates'),('binding_action_release_events'),('board_briefs'),
  ('calculation_items'),('company_calculation_gap_tenders'),('company_profile_approvals'),
  ('configuration_audit'),('configuration_changes'),('external_action_receipts'),
  ('external_submission_approvals'),('external_submission_continuations'),('external_submission_jobs'),
  ('external_submission_notifications'),('external_submission_receipts'),('external_submission_reconciliation'),
  ('external_submission_transitions'),('external_submission_uploads'),('final_preflight_requirements'),
  ('final_preflight_user_actions'),('generated_documents'),('package_readiness_checks'),('pipeline_transitions'),
  ('portal_account_identity_evidence'),('portal_submission_schemas'),('rc321_json_shape_repairs'),
  ('required_document_company_evidence_links'),('required_document_package_bindings'),
  ('required_document_rechecks'),('signature_document_uploads'),('submission_document_mappings'),
  ('submission_package_manifests'),('submission_preflight_checks'),('submission_reconciliation_jobs'),
  ('submission_state_transitions');

CREATE TEMP TABLE active_company_scope AS
SELECT company.company_id,binding.tenant_id,company.legal_name
FROM tender.enterprise_company_links company
JOIN saas.legacy_company_tenant_bindings binding ON binding.company_id=company.company_id
WHERE company.active;

CREATE TEMP TABLE unscoped_counts(table_name text PRIMARY KEY,row_count bigint NOT NULL) ON COMMIT DROP;
SELECT format('INSERT INTO unscoped_counts SELECT %L,count(*) FROM tender.%I;',table_name,table_name)
FROM protected_tables ORDER BY table_name
\gexec

CREATE TEMP TABLE scoped_counts(company_id uuid,table_name text,row_count bigint NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE empty_scope_counts(table_name text,row_count bigint NOT NULL) ON COMMIT DROP;
GRANT SELECT ON active_company_scope,protected_tables TO tender_api_runtime;
GRANT INSERT ON scoped_counts,empty_scope_counts TO tender_api_runtime;

\o /dev/null
SELECT format(
  'SELECT set_config(''app.tenant_ids'',%L,true); SELECT set_config(''app.tenant_id'',%L,true); SELECT set_config(''app.company_ids'',%L,true); SET LOCAL ROLE tender_api_runtime; INSERT INTO scoped_counts SELECT %L,%L,count(*) FROM tender.%I; RESET ROLE;',
  tenant_id::text,tenant_id::text,company_id::text,company_id::text,table_name,table_name
)
FROM active_company_scope CROSS JOIN protected_tables
ORDER BY legal_name,table_name
\gexec

SELECT set_config('app.tenant_ids','',true);
SELECT set_config('app.tenant_id','',true);
SELECT set_config('app.company_ids','',true);
SET LOCAL ROLE tender_api_runtime;
SELECT format('INSERT INTO empty_scope_counts SELECT %L,count(*) FROM tender.%I;',table_name,table_name)
FROM protected_tables ORDER BY table_name
\gexec
RESET ROLE;
\o

DO $$ DECLARE failures jsonb; BEGIN
  IF (SELECT count(*) FROM active_company_scope) < 1 THEN
    RAISE EXCEPTION 'no_active_companies_discovered';
  END IF;
  IF (SELECT count(*) FROM protected_tables) <> 35 THEN
    RAISE EXCEPTION 'protected_table_inventory_incomplete';
  END IF;
  IF EXISTS(
    SELECT 1 FROM protected_tables target
    JOIN pg_class relation ON relation.oid=('tender.'||target.table_name)::regclass
    LEFT JOIN pg_policies policy ON policy.schemaname='tender'
      AND policy.tablename=target.table_name AND policy.policyname='runtime_parent_scope'
    WHERE NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity OR policy.policyname IS NULL
  ) THEN
    RAISE EXCEPTION 'runtime_child_policy_or_force_rls_missing';
  END IF;
  IF EXISTS(SELECT 1 FROM empty_scope_counts WHERE row_count<>0) THEN
    SELECT jsonb_agg(to_jsonb(failure)) INTO failures
    FROM (SELECT * FROM empty_scope_counts WHERE row_count<>0 ORDER BY table_name) failure;
    RAISE EXCEPTION 'empty_runtime_scope_exposed_rows: %',failures;
  END IF;
  IF (SELECT count(*) FROM scoped_counts) <>
     (SELECT count(*) FROM active_company_scope)*(SELECT count(*) FROM protected_tables) THEN
    RAISE EXCEPTION 'company_table_matrix_incomplete';
  END IF;
  IF EXISTS(
    SELECT 1 FROM unscoped_counts expected
    LEFT JOIN (SELECT table_name,sum(row_count) row_count FROM scoped_counts GROUP BY table_name) observed
      USING(table_name)
    WHERE expected.row_count<coalesce(observed.row_count,0)
  ) THEN
    SELECT jsonb_agg(to_jsonb(failure)) INTO failures FROM (
      SELECT expected.table_name,expected.row_count expected_rows,coalesce(observed.row_count,0) scoped_rows
      FROM unscoped_counts expected
      LEFT JOIN (SELECT table_name,sum(row_count) row_count FROM scoped_counts GROUP BY table_name) observed
        USING(table_name)
      WHERE expected.row_count<coalesce(observed.row_count,0)
      ORDER BY expected.table_name
    ) failure;
    RAISE EXCEPTION 'rows_exposed_to_multiple_active_companies: %',failures;
  END IF;
END $$;

SELECT json_build_object(
  'passed',true,
  'activeCompanies',(SELECT count(*) FROM active_company_scope),
  'protectedTables',(SELECT count(*) FROM protected_tables),
  'matrixChecks',(SELECT count(*) FROM scoped_counts),
  'emptyScopeExposedRows',(SELECT coalesce(sum(row_count),0) FROM empty_scope_counts),
  'protectedRows',(SELECT sum(row_count) FROM unscoped_counts),
  'activeCompanyBoundRows',(SELECT sum(row_count) FROM scoped_counts),
  'failClosedUnboundOrInactiveRows',(
    SELECT sum(expected.row_count-coalesce(observed.row_count,0))
    FROM unscoped_counts expected
    LEFT JOIN (SELECT table_name,sum(row_count) row_count FROM scoped_counts GROUP BY table_name) observed USING(table_name)
  ),
  'physicalDeletes',0,
  'externalWrite',false
);

ROLLBACK;
