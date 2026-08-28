\set ON_ERROR_STOP on

DO $$
BEGIN
  IF (SELECT procurement_verification_status FROM tender.enrichment_documents
      WHERE id='00000000-0000-4000-8000-000000001241')<>'VERIFIED' THEN
    RAISE EXCEPTION 'eligible_clean_document_not_reconciled';
  END IF;
  IF EXISTS(SELECT 1 FROM tender.enrichment_documents
      WHERE id IN('00000000-0000-4000-8000-000000001242','00000000-0000-4000-8000-000000001243','00000000-0000-4000-8000-000000001244')
        AND procurement_verification_status='VERIFIED') THEN
    RAISE EXCEPTION 'unsafe_document_reconciled';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.schema_migrations
      WHERE version='0124-clean-document-scan-reconciliation') THEN
    RAISE EXCEPTION 'migration_124_ledger_missing';
  END IF;
END $$;

INSERT INTO tender.enrichment_documents(id,enrichment_version_id,source_url,filename,fetch_status,
  mime_type,payload_sha256,content,provenance,resolution_status,document_class,
  procurement_relevant,tender_association_verified,lot_association_verified,
  magic_bytes_verified,content_size,procurement_verification_status)
VALUES('00000000-0000-4000-8000-000000001245','00000000-0000-4000-8000-000000001240',
  'https://staging.invalid/continuous.pdf','continuous.pdf','VORHANDEN','application/pdf',repeat('5',64),
  decode('25504446','hex'),'{"procurementVerified":true,"lotScope":"TENDER_GLOBAL"}',
  'DOWNLOAD_SUCCEEDED','SPECIFICATION',true,true,true,true,4,'REVIEW_REQUIRED');

UPDATE tender.document_malware_scans SET status='CLEAN',detail_code='clean',scanned_at=now()
WHERE document_id='00000000-0000-4000-8000-000000001245' AND payload_sha256=repeat('5',64);

DO $$
BEGIN
  IF (SELECT procurement_verification_status FROM tender.enrichment_documents
      WHERE id='00000000-0000-4000-8000-000000001245')<>'VERIFIED' THEN
    RAISE EXCEPTION 'continuous_clean_scan_reconciliation_failed';
  END IF;
END $$;

SELECT 'clean_document_scan_reconciliation_5_of_5' result;
