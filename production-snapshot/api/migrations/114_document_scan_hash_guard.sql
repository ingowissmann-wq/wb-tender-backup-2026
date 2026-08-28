BEGIN;

CREATE OR REPLACE FUNCTION tender.require_current_document_malware_scan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, tender
AS $$
BEGIN
  IF NEW.procurement_relevant AND NEW.payload_sha256 IS NOT NULL THEN
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

DROP TRIGGER IF EXISTS enrichment_document_current_hash_scan_guard ON tender.enrichment_documents;
CREATE TRIGGER enrichment_document_current_hash_scan_guard
AFTER INSERT OR UPDATE OF payload_sha256,procurement_relevant
ON tender.enrichment_documents
FOR EACH ROW EXECUTE FUNCTION tender.require_current_document_malware_scan();

INSERT INTO tender.document_malware_scans(document_id,payload_sha256,status)
SELECT document.id,document.payload_sha256,'PENDING'
FROM tender.enrichment_documents document
WHERE document.procurement_relevant AND document.payload_sha256 IS NOT NULL
ON CONFLICT(document_id,payload_sha256) DO NOTHING;

UPDATE tender.enrichment_documents document
SET procurement_verification_status='REVIEW_REQUIRED'
WHERE document.procurement_relevant
  AND document.payload_sha256 IS NOT NULL
  AND document.procurement_verification_status='VERIFIED'
  AND NOT EXISTS(
    SELECT 1 FROM tender.document_malware_scans scan
    WHERE scan.document_id=document.id
      AND scan.payload_sha256=document.payload_sha256
      AND scan.status='CLEAN'
  );

COMMIT;
