BEGIN;

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';

DROP TRIGGER IF EXISTS clean_document_scan_verification_reconciliation ON tender.document_malware_scans;
DROP FUNCTION IF EXISTS tender.reconcile_clean_document_scan_verification();
DELETE FROM app.schema_migrations WHERE version='0124-clean-document-scan-reconciliation';

-- Preserve every safely reconciled document status and all audit provenance.

COMMIT;
