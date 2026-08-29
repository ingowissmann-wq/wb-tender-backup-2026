\set ON_ERROR_STOP on

UPDATE tender.enrichment_documents
SET procurement_verification_status='REVIEW_REQUIRED'
WHERE id='00000000-0000-4000-8000-000000001245';

UPDATE tender.document_malware_scans SET status='PENDING'
WHERE document_id='00000000-0000-4000-8000-000000001245' AND payload_sha256=repeat('5',64);
UPDATE tender.document_malware_scans SET status='CLEAN'
WHERE document_id='00000000-0000-4000-8000-000000001245' AND payload_sha256=repeat('5',64);

DO $$
BEGIN
  IF (SELECT procurement_verification_status FROM tender.enrichment_documents
      WHERE id='00000000-0000-4000-8000-000000001245')<>'REVIEW_REQUIRED' THEN
    RAISE EXCEPTION 'down_migration_left_scan_reconciliation_trigger_active';
  END IF;
  IF (SELECT procurement_verification_status FROM tender.enrichment_documents
      WHERE id='00000000-0000-4000-8000-000000001241')<>'VERIFIED' THEN
    RAISE EXCEPTION 'down_migration_reverted_reconciled_productive_status';
  END IF;
  IF EXISTS(SELECT 1 FROM app.schema_migrations
      WHERE version='0124-clean-document-scan-reconciliation') THEN
    RAISE EXCEPTION 'down_migration_ledger_entry_retained';
  END IF;
END $$;

SELECT 'clean_document_scan_rollback_3_of_3' result;
