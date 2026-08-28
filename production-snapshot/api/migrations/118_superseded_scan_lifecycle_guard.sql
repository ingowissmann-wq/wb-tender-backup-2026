BEGIN;

CREATE OR REPLACE FUNCTION tender.require_current_document_malware_scan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, tender
AS $$
BEGIN
  IF NEW.procurement_relevant AND NEW.payload_sha256 IS NOT NULL THEN
    UPDATE tender.document_malware_scans
    SET status='QUARANTINED',detail_code='SUPERSEDED_PAYLOAD_HASH',next_retry_at=NULL
    WHERE document_id=NEW.id
      AND payload_sha256<>NEW.payload_sha256
      AND status IN('PENDING','SCAN_ERROR');

    INSERT INTO tender.document_malware_scans(document_id,payload_sha256,status)
    VALUES(NEW.id,NEW.payload_sha256,'PENDING')
    ON CONFLICT(document_id,payload_sha256) DO NOTHING;

    IF NOT EXISTS(
      SELECT 1 FROM tender.document_malware_scans scan
      WHERE scan.document_id=NEW.id
        AND scan.payload_sha256=NEW.payload_sha256
        AND scan.status='CLEAN'
    ) THEN
      UPDATE tender.enrichment_documents
      SET procurement_verification_status='REVIEW_REQUIRED'
      WHERE id=NEW.id AND procurement_verification_status='VERIFIED';
    END IF;
  END IF;
  RETURN NULL;
END $$;

UPDATE tender.document_malware_scans scan
SET status='QUARANTINED',detail_code='SUPERSEDED_PAYLOAD_HASH',next_retry_at=NULL
WHERE scan.status IN('PENDING','SCAN_ERROR')
  AND NOT EXISTS(
    SELECT 1 FROM tender.enrichment_documents document
    WHERE document.id=scan.document_id
      AND document.payload_sha256=scan.payload_sha256
  );

COMMIT;
