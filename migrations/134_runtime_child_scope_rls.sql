BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';

SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:runtime-child-scope-rls:134',0));

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
    EXECUTE format('ALTER TABLE tender.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE tender.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS runtime_parent_scope ON tender.%I',table_name);
  END LOOP;
END $$;

CREATE POLICY runtime_parent_scope ON tender.approval_events
USING(EXISTS(SELECT 1 FROM tender.approval_requests p WHERE p.id=approval_events.approval_request_id))
WITH CHECK(EXISTS(SELECT 1 FROM tender.approval_requests p WHERE p.id=approval_events.approval_request_id));

CREATE POLICY runtime_parent_scope ON tender.bid_submission_gates
USING(EXISTS(SELECT 1 FROM tender.bid_packages p WHERE p.id=bid_submission_gates.bid_package_id)
  AND (approval_request_id IS NULL OR EXISTS(SELECT 1 FROM tender.approval_requests a WHERE a.id=bid_submission_gates.approval_request_id)))
WITH CHECK(EXISTS(SELECT 1 FROM tender.bid_packages p WHERE p.id=bid_submission_gates.bid_package_id)
  AND (approval_request_id IS NULL OR EXISTS(SELECT 1 FROM tender.approval_requests a WHERE a.id=bid_submission_gates.approval_request_id)));

CREATE POLICY runtime_parent_scope ON tender.binding_action_release_events
USING(EXISTS(SELECT 1 FROM tender.binding_action_releases p WHERE p.id=binding_action_release_events.release_id))
WITH CHECK(EXISTS(SELECT 1 FROM tender.binding_action_releases p WHERE p.id=binding_action_release_events.release_id));

CREATE POLICY runtime_parent_scope ON tender.board_briefs
USING(EXISTS(SELECT 1 FROM tender.management_inbox p WHERE p.id=board_briefs.inbox_id))
WITH CHECK(EXISTS(SELECT 1 FROM tender.management_inbox p WHERE p.id=board_briefs.inbox_id));

CREATE POLICY runtime_parent_scope ON tender.calculation_items
USING(EXISTS(SELECT 1 FROM tender.calculations p WHERE p.id=calculation_items.calculation_id))
WITH CHECK(EXISTS(SELECT 1 FROM tender.calculations p WHERE p.id=calculation_items.calculation_id));

CREATE POLICY runtime_parent_scope ON tender.company_calculation_gap_tenders
USING(EXISTS(SELECT 1 FROM tender.company_calculation_gap_tasks p WHERE p.id=company_calculation_gap_tenders.task_id))
WITH CHECK(EXISTS(SELECT 1 FROM tender.company_calculation_gap_tasks p WHERE p.id=company_calculation_gap_tenders.task_id));

CREATE POLICY runtime_parent_scope ON tender.company_profile_approvals
USING(EXISTS(SELECT 1 FROM tender.company_profiles p WHERE p.id=company_profile_approvals.company_profile_id))
WITH CHECK(EXISTS(SELECT 1 FROM tender.company_profiles p WHERE p.id=company_profile_approvals.company_profile_id));

CREATE POLICY runtime_parent_scope ON tender.configuration_audit
USING(EXISTS(SELECT 1 FROM tender.configuration_versions p WHERE p.id=configuration_audit.version_id))
WITH CHECK(EXISTS(SELECT 1 FROM tender.configuration_versions p WHERE p.id=configuration_audit.version_id));

CREATE POLICY runtime_parent_scope ON tender.configuration_changes
USING(EXISTS(SELECT 1 FROM tender.configuration_versions p WHERE p.id=configuration_changes.version_id))
WITH CHECK(EXISTS(SELECT 1 FROM tender.configuration_versions p WHERE p.id=configuration_changes.version_id));

CREATE POLICY runtime_parent_scope ON tender.external_action_receipts
USING(EXISTS(SELECT 1 FROM tender.approval_requests a WHERE a.id=external_action_receipts.approval_request_id)
  AND (submission_context_id IS NULL OR EXISTS(SELECT 1 FROM tender.submission_contexts s WHERE s.id=external_action_receipts.submission_context_id))
  AND (receipt_id IS NULL OR EXISTS(SELECT 1 FROM tender.submission_receipts r WHERE r.id=external_action_receipts.receipt_id)))
WITH CHECK(EXISTS(SELECT 1 FROM tender.approval_requests a WHERE a.id=external_action_receipts.approval_request_id)
  AND (submission_context_id IS NULL OR EXISTS(SELECT 1 FROM tender.submission_contexts s WHERE s.id=external_action_receipts.submission_context_id))
  AND (receipt_id IS NULL OR EXISTS(SELECT 1 FROM tender.submission_receipts r WHERE r.id=external_action_receipts.receipt_id)));

CREATE POLICY runtime_parent_scope ON tender.external_submission_approvals
USING(EXISTS(SELECT 1 FROM tender.external_submissions s WHERE s.id=external_submission_approvals.submission_id)
  AND EXISTS(SELECT 1 FROM tender.bid_packages p WHERE p.id=external_submission_approvals.bid_package_id))
WITH CHECK(EXISTS(SELECT 1 FROM tender.external_submissions s WHERE s.id=external_submission_approvals.submission_id)
  AND EXISTS(SELECT 1 FROM tender.bid_packages p WHERE p.id=external_submission_approvals.bid_package_id));

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'external_submission_continuations','external_submission_jobs','external_submission_notifications',
    'external_submission_receipts','external_submission_reconciliation','external_submission_transitions',
    'external_submission_uploads'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY runtime_parent_scope ON tender.%1$I USING(EXISTS(SELECT 1 FROM tender.external_submissions p WHERE p.id=%1$I.submission_id)) WITH CHECK(EXISTS(SELECT 1 FROM tender.external_submissions p WHERE p.id=%1$I.submission_id))',
      table_name
    );
  END LOOP;
END $$;

CREATE POLICY runtime_parent_scope ON tender.final_preflight_requirements
USING(EXISTS(SELECT 1 FROM tender.final_preflight_contexts p WHERE p.id=final_preflight_requirements.context_id))
WITH CHECK(EXISTS(SELECT 1 FROM tender.final_preflight_contexts p WHERE p.id=final_preflight_requirements.context_id));

CREATE POLICY runtime_parent_scope ON tender.final_preflight_user_actions
USING(EXISTS(SELECT 1 FROM tender.final_preflight_contexts p WHERE p.id=final_preflight_user_actions.context_id))
WITH CHECK(EXISTS(SELECT 1 FROM tender.final_preflight_contexts p WHERE p.id=final_preflight_user_actions.context_id));

CREATE POLICY runtime_parent_scope ON tender.generated_documents
USING((bid_package_id IS NOT NULL OR calculation_id IS NOT NULL)
  AND (bid_package_id IS NULL OR EXISTS(SELECT 1 FROM tender.bid_packages p WHERE p.id=generated_documents.bid_package_id))
  AND (calculation_id IS NULL OR EXISTS(SELECT 1 FROM tender.calculations c WHERE c.id=generated_documents.calculation_id)))
WITH CHECK((bid_package_id IS NOT NULL OR calculation_id IS NOT NULL)
  AND (bid_package_id IS NULL OR EXISTS(SELECT 1 FROM tender.bid_packages p WHERE p.id=generated_documents.bid_package_id))
  AND (calculation_id IS NULL OR EXISTS(SELECT 1 FROM tender.calculations c WHERE c.id=generated_documents.calculation_id)));

CREATE POLICY runtime_parent_scope ON tender.package_readiness_checks
USING(EXISTS(SELECT 1 FROM tender.final_preflight_contexts c WHERE c.id=package_readiness_checks.context_id)
  AND (bid_package_id IS NULL OR EXISTS(SELECT 1 FROM tender.bid_packages p WHERE p.id=package_readiness_checks.bid_package_id)))
WITH CHECK(EXISTS(SELECT 1 FROM tender.final_preflight_contexts c WHERE c.id=package_readiness_checks.context_id)
  AND (bid_package_id IS NULL OR EXISTS(SELECT 1 FROM tender.bid_packages p WHERE p.id=package_readiness_checks.bid_package_id)));

CREATE POLICY runtime_parent_scope ON tender.pipeline_transitions
USING(EXISTS(SELECT 1 FROM tender.pipeline_contexts c WHERE c.id=pipeline_transitions.pipeline_context_id)
  AND (job_id IS NULL OR EXISTS(SELECT 1 FROM tender.autopilot_queue q WHERE q.id=pipeline_transitions.job_id)))
WITH CHECK(EXISTS(SELECT 1 FROM tender.pipeline_contexts c WHERE c.id=pipeline_transitions.pipeline_context_id)
  AND (job_id IS NULL OR EXISTS(SELECT 1 FROM tender.autopilot_queue q WHERE q.id=pipeline_transitions.job_id)));

CREATE POLICY runtime_parent_scope ON tender.portal_account_identity_evidence
USING(EXISTS(SELECT 1 FROM tender.portal_credential_secrets p WHERE p.id=portal_account_identity_evidence.credential_id))
WITH CHECK(EXISTS(SELECT 1 FROM tender.portal_credential_secrets p WHERE p.id=portal_account_identity_evidence.credential_id));

CREATE POLICY runtime_parent_scope ON tender.portal_submission_schemas
USING(EXISTS(SELECT 1 FROM tender.final_preflight_contexts c WHERE c.id=portal_submission_schemas.context_id)
  AND (submission_context_id IS NULL OR EXISTS(SELECT 1 FROM tender.submission_contexts s WHERE s.id=portal_submission_schemas.submission_context_id)))
WITH CHECK(EXISTS(SELECT 1 FROM tender.final_preflight_contexts c WHERE c.id=portal_submission_schemas.context_id)
  AND (submission_context_id IS NULL OR EXISTS(SELECT 1 FROM tender.submission_contexts s WHERE s.id=portal_submission_schemas.submission_context_id)));

CREATE POLICY runtime_parent_scope ON tender.rc321_json_shape_repairs
USING(EXISTS(SELECT 1 FROM tender.management_inbox p WHERE p.id=rc321_json_shape_repairs.inbox_id))
WITH CHECK(EXISTS(SELECT 1 FROM tender.management_inbox p WHERE p.id=rc321_json_shape_repairs.inbox_id));

CREATE POLICY runtime_parent_scope ON tender.required_document_company_evidence_links
USING(EXISTS(SELECT 1 FROM tender.required_documents d WHERE d.id=required_document_company_evidence_links.required_document_id)
  AND EXISTS(SELECT 1 FROM tender.evidence_items e WHERE e.id=required_document_company_evidence_links.evidence_item_id))
WITH CHECK(EXISTS(SELECT 1 FROM tender.required_documents d WHERE d.id=required_document_company_evidence_links.required_document_id)
  AND EXISTS(SELECT 1 FROM tender.evidence_items e WHERE e.id=required_document_company_evidence_links.evidence_item_id));

CREATE POLICY runtime_parent_scope ON tender.required_document_package_bindings
USING(EXISTS(SELECT 1 FROM tender.required_documents d WHERE d.id=required_document_package_bindings.required_document_id)
  AND EXISTS(SELECT 1 FROM tender.bid_packages p WHERE p.id=required_document_package_bindings.bid_package_id)
  AND EXISTS(SELECT 1 FROM tender.required_document_uploads u WHERE u.id=required_document_package_bindings.upload_id))
WITH CHECK(EXISTS(SELECT 1 FROM tender.required_documents d WHERE d.id=required_document_package_bindings.required_document_id)
  AND EXISTS(SELECT 1 FROM tender.bid_packages p WHERE p.id=required_document_package_bindings.bid_package_id)
  AND EXISTS(SELECT 1 FROM tender.required_document_uploads u WHERE u.id=required_document_package_bindings.upload_id));

CREATE POLICY runtime_parent_scope ON tender.required_document_rechecks
USING(EXISTS(SELECT 1 FROM tender.required_documents d WHERE d.id=required_document_rechecks.required_document_id)
  AND (trigger_upload_id IS NULL OR EXISTS(SELECT 1 FROM tender.required_document_uploads u WHERE u.id=required_document_rechecks.trigger_upload_id)))
WITH CHECK(EXISTS(SELECT 1 FROM tender.required_documents d WHERE d.id=required_document_rechecks.required_document_id)
  AND (trigger_upload_id IS NULL OR EXISTS(SELECT 1 FROM tender.required_document_uploads u WHERE u.id=required_document_rechecks.trigger_upload_id)));

CREATE POLICY runtime_parent_scope ON tender.signature_document_uploads
USING(EXISTS(SELECT 1 FROM tender.signature_documents p WHERE p.id=signature_document_uploads.signature_document_id))
WITH CHECK(EXISTS(SELECT 1 FROM tender.signature_documents p WHERE p.id=signature_document_uploads.signature_document_id));

CREATE POLICY runtime_parent_scope ON tender.submission_document_mappings
USING(EXISTS(SELECT 1 FROM tender.submission_contexts p WHERE p.id=submission_document_mappings.submission_context_id))
WITH CHECK(EXISTS(SELECT 1 FROM tender.submission_contexts p WHERE p.id=submission_document_mappings.submission_context_id));

CREATE POLICY runtime_parent_scope ON tender.submission_package_manifests
USING(EXISTS(SELECT 1 FROM tender.submission_contexts s WHERE s.id=submission_package_manifests.submission_context_id)
  AND EXISTS(SELECT 1 FROM tender.approval_requests a WHERE a.id=submission_package_manifests.approval_request_id))
WITH CHECK(EXISTS(SELECT 1 FROM tender.submission_contexts s WHERE s.id=submission_package_manifests.submission_context_id)
  AND EXISTS(SELECT 1 FROM tender.approval_requests a WHERE a.id=submission_package_manifests.approval_request_id));

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'submission_preflight_checks','submission_reconciliation_jobs','submission_state_transitions'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY runtime_parent_scope ON tender.%1$I USING(EXISTS(SELECT 1 FROM tender.submission_contexts p WHERE p.id=%1$I.submission_context_id)) WITH CHECK(EXISTS(SELECT 1 FROM tender.submission_contexts p WHERE p.id=%1$I.submission_context_id))',
      table_name
    );
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS approval_events_runtime_parent_idx ON tender.approval_events(approval_request_id);
CREATE INDEX IF NOT EXISTS bid_submission_gates_approval_runtime_parent_idx ON tender.bid_submission_gates(approval_request_id);
CREATE INDEX IF NOT EXISTS binding_action_release_events_runtime_parent_idx ON tender.binding_action_release_events(release_id);
CREATE INDEX IF NOT EXISTS calculation_items_runtime_parent_idx ON tender.calculation_items(calculation_id);
CREATE INDEX IF NOT EXISTS configuration_audit_runtime_parent_idx ON tender.configuration_audit(version_id);
CREATE INDEX IF NOT EXISTS external_action_receipts_approval_runtime_parent_idx ON tender.external_action_receipts(approval_request_id);
CREATE INDEX IF NOT EXISTS external_action_receipts_receipt_runtime_parent_idx ON tender.external_action_receipts(receipt_id);
CREATE INDEX IF NOT EXISTS external_action_receipts_context_runtime_parent_idx ON tender.external_action_receipts(submission_context_id);
CREATE INDEX IF NOT EXISTS external_submission_approvals_package_runtime_parent_idx ON tender.external_submission_approvals(bid_package_id);
CREATE INDEX IF NOT EXISTS external_submission_continuations_runtime_parent_idx ON tender.external_submission_continuations(submission_id);
CREATE INDEX IF NOT EXISTS external_submission_reconciliation_runtime_parent_idx ON tender.external_submission_reconciliation(submission_id);
CREATE INDEX IF NOT EXISTS external_submission_transitions_runtime_parent_idx ON tender.external_submission_transitions(submission_id);
CREATE INDEX IF NOT EXISTS final_preflight_user_actions_runtime_parent_idx ON tender.final_preflight_user_actions(context_id);
CREATE INDEX IF NOT EXISTS generated_documents_calculation_runtime_parent_idx ON tender.generated_documents(calculation_id);
CREATE INDEX IF NOT EXISTS package_readiness_checks_package_runtime_parent_idx ON tender.package_readiness_checks(bid_package_id);
CREATE INDEX IF NOT EXISTS package_readiness_checks_context_runtime_parent_idx ON tender.package_readiness_checks(context_id);
CREATE INDEX IF NOT EXISTS pipeline_transitions_job_runtime_parent_idx ON tender.pipeline_transitions(job_id);
CREATE INDEX IF NOT EXISTS pipeline_transitions_context_runtime_parent_idx ON tender.pipeline_transitions(pipeline_context_id);
CREATE INDEX IF NOT EXISTS portal_account_identity_evidence_runtime_parent_idx ON tender.portal_account_identity_evidence(credential_id);
CREATE INDEX IF NOT EXISTS portal_submission_schemas_submission_runtime_parent_idx ON tender.portal_submission_schemas(submission_context_id);
CREATE INDEX IF NOT EXISTS required_document_company_evidence_item_runtime_parent_idx ON tender.required_document_company_evidence_links(evidence_item_id);
CREATE INDEX IF NOT EXISTS required_document_package_bindings_package_runtime_parent_idx ON tender.required_document_package_bindings(bid_package_id);
CREATE INDEX IF NOT EXISTS required_document_package_bindings_document_runtime_parent_idx ON tender.required_document_package_bindings(required_document_id);
CREATE INDEX IF NOT EXISTS required_document_rechecks_document_runtime_parent_idx ON tender.required_document_rechecks(required_document_id);
CREATE INDEX IF NOT EXISTS required_document_rechecks_upload_runtime_parent_idx ON tender.required_document_rechecks(trigger_upload_id);
CREATE INDEX IF NOT EXISTS submission_package_manifests_approval_runtime_parent_idx ON tender.submission_package_manifests(approval_request_id);
CREATE INDEX IF NOT EXISTS submission_reconciliation_jobs_runtime_parent_idx ON tender.submission_reconciliation_jobs(submission_context_id);

INSERT INTO tender.audit_events(action,metadata)
SELECT 'runtime_child_scope_rls_enabled',jsonb_build_object(
  'release','20260825-runtime-child-scope-rls-134.1',
  'protectedTables',35,'policyMode','ALL_PROTECTED_PARENTS_VISIBLE',
  'physicalDeletes',0,'externalWrite',false
)
WHERE NOT EXISTS(
  SELECT 1 FROM tender.audit_events
  WHERE action='runtime_child_scope_rls_enabled'
    AND metadata->>'release'='20260825-runtime-child-scope-rls-134.1'
);

INSERT INTO app.schema_migrations(version,description)
VALUES('0134-runtime-child-scope-rls',
  'Force runtime row isolation on company-sensitive workflow child tables through every protected parent')
ON CONFLICT(version) DO NOTHING;

COMMIT;
