BEGIN;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'approval_events','bid_submission_gates','binding_action_release_events','board_briefs',
    'calculation_items','company_calculation_gap_tenders','company_profile_approvals',
    'configuration_audit','configuration_changes','external_action_receipts',
    'external_submission_approvals','external_submission_continuations','external_submission_jobs',
    'external_submission_notifications','external_submission_receipts','external_submission_reconciliation',
    'external_submission_transitions','external_submission_uploads','final_preflight_requirements',
    'final_preflight_user_actions','generated_documents','package_readiness_checks','pipeline_transitions',
    'portal_account_identity_evidence','portal_submission_schemas','rc321_json_shape_repairs',
    'required_document_company_evidence_links','required_document_package_bindings',
    'required_document_rechecks','signature_document_uploads','submission_document_mappings',
    'submission_package_manifests','submission_preflight_checks','submission_reconciliation_jobs',
    'submission_state_transitions'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS runtime_parent_scope ON tender.%I',table_name);
    EXECUTE format('ALTER TABLE tender.%I NO FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE tender.%I DISABLE ROW LEVEL SECURITY',table_name);
  END LOOP;
END $$;

DROP INDEX IF EXISTS tender.approval_events_runtime_parent_idx;
DROP INDEX IF EXISTS tender.bid_submission_gates_approval_runtime_parent_idx;
DROP INDEX IF EXISTS tender.binding_action_release_events_runtime_parent_idx;
DROP INDEX IF EXISTS tender.calculation_items_runtime_parent_idx;
DROP INDEX IF EXISTS tender.configuration_audit_runtime_parent_idx;
DROP INDEX IF EXISTS tender.external_action_receipts_approval_runtime_parent_idx;
DROP INDEX IF EXISTS tender.external_action_receipts_receipt_runtime_parent_idx;
DROP INDEX IF EXISTS tender.external_action_receipts_context_runtime_parent_idx;
DROP INDEX IF EXISTS tender.external_submission_approvals_package_runtime_parent_idx;
DROP INDEX IF EXISTS tender.external_submission_continuations_runtime_parent_idx;
DROP INDEX IF EXISTS tender.external_submission_reconciliation_runtime_parent_idx;
DROP INDEX IF EXISTS tender.external_submission_transitions_runtime_parent_idx;
DROP INDEX IF EXISTS tender.final_preflight_user_actions_runtime_parent_idx;
DROP INDEX IF EXISTS tender.generated_documents_calculation_runtime_parent_idx;
DROP INDEX IF EXISTS tender.package_readiness_checks_package_runtime_parent_idx;
DROP INDEX IF EXISTS tender.package_readiness_checks_context_runtime_parent_idx;
DROP INDEX IF EXISTS tender.pipeline_transitions_job_runtime_parent_idx;
DROP INDEX IF EXISTS tender.pipeline_transitions_context_runtime_parent_idx;
DROP INDEX IF EXISTS tender.portal_account_identity_evidence_runtime_parent_idx;
DROP INDEX IF EXISTS tender.portal_submission_schemas_submission_runtime_parent_idx;
DROP INDEX IF EXISTS tender.required_document_company_evidence_item_runtime_parent_idx;
DROP INDEX IF EXISTS tender.required_document_package_bindings_package_runtime_parent_idx;
DROP INDEX IF EXISTS tender.required_document_package_bindings_document_runtime_parent_idx;
DROP INDEX IF EXISTS tender.required_document_rechecks_document_runtime_parent_idx;
DROP INDEX IF EXISTS tender.required_document_rechecks_upload_runtime_parent_idx;
DROP INDEX IF EXISTS tender.submission_package_manifests_approval_runtime_parent_idx;
DROP INDEX IF EXISTS tender.submission_reconciliation_jobs_runtime_parent_idx;

DELETE FROM app.schema_migrations WHERE version='0134-runtime-child-scope-rls';

COMMIT;
