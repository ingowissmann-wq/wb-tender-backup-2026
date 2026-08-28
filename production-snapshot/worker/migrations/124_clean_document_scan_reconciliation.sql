BEGIN;

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15min';

INSERT INTO tender.context_backfill_runs(release_id,before_counts,external_submission_enabled)
VALUES('20260825-clean-document-scan-reconciliation-124.1',jsonb_build_object(
  'clean_documents_awaiting_safe_reconciliation',(
    SELECT count(*) FROM tender.enrichment_documents document
    JOIN tender.document_malware_scans scan
      ON scan.document_id=document.id AND scan.payload_sha256=document.payload_sha256
    WHERE scan.status='CLEAN' AND document.procurement_relevant
      AND document.procurement_verification_status='REVIEW_REQUIRED'
      AND document.provenance->>'procurementVerified'='true'
      AND document.provenance->>'statusGuard' IS NULL
      AND document.fetch_status='VORHANDEN'
      AND document.resolution_status='DOWNLOAD_SUCCEEDED'
      AND document.tender_association_verified AND document.lot_association_verified
      AND document.magic_bytes_verified AND document.content IS NOT NULL
      AND document.payload_sha256 IS NOT NULL
  )
),false)
ON CONFLICT(release_id) DO NOTHING;

CREATE OR REPLACE FUNCTION tender.reconcile_clean_document_scan_verification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,tender
AS $$
BEGIN
  IF NEW.status='CLEAN' THEN
    UPDATE tender.enrichment_documents document
    SET procurement_verification_status='VERIFIED',
        provenance=coalesce(document.provenance,'{}'::jsonb)||jsonb_build_object(
          'malwareScanReconciled',true,
          'malwareScanPayloadSha256',NEW.payload_sha256,
          'malwareScanReconciledAt',now(),
          'invented',false
        )
    WHERE document.id=NEW.document_id AND document.payload_sha256=NEW.payload_sha256
      AND document.procurement_relevant
      AND document.procurement_verification_status='REVIEW_REQUIRED'
      AND document.provenance->>'procurementVerified'='true'
      AND document.provenance->>'statusGuard' IS NULL
      AND document.fetch_status='VORHANDEN'
      AND document.resolution_status='DOWNLOAD_SUCCEEDED'
      AND document.tender_association_verified AND document.lot_association_verified
      AND document.magic_bytes_verified AND document.content IS NOT NULL;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS clean_document_scan_verification_reconciliation ON tender.document_malware_scans;
CREATE TRIGGER clean_document_scan_verification_reconciliation
AFTER INSERT OR UPDATE OF status,payload_sha256
ON tender.document_malware_scans
FOR EACH ROW EXECUTE FUNCTION tender.reconcile_clean_document_scan_verification();

UPDATE tender.enrichment_documents document
SET procurement_verification_status='VERIFIED',
    provenance=coalesce(document.provenance,'{}'::jsonb)||jsonb_build_object(
      'malwareScanReconciled',true,
      'malwareScanPayloadSha256',document.payload_sha256,
      'malwareScanReconciledAt',now(),
      'invented',false
    )
FROM tender.document_malware_scans scan
WHERE scan.document_id=document.id AND scan.payload_sha256=document.payload_sha256
  AND scan.status='CLEAN' AND document.procurement_relevant
  AND document.procurement_verification_status='REVIEW_REQUIRED'
  AND document.provenance->>'procurementVerified'='true'
  AND document.provenance->>'statusGuard' IS NULL
  AND document.fetch_status='VORHANDEN'
  AND document.resolution_status='DOWNLOAD_SUCCEEDED'
  AND document.tender_association_verified AND document.lot_association_verified
  AND document.magic_bytes_verified AND document.content IS NOT NULL;

UPDATE tender.context_backfill_runs
SET finished_at=now(),after_counts=jsonb_build_object(
  'safely_reconciled_documents',(
    SELECT count(*) FROM tender.enrichment_documents document
    WHERE document.provenance->>'malwareScanReconciled'='true'
  ),
  'external_submission_enabled',false,
  'physical_deletes',0
)
WHERE release_id='20260825-clean-document-scan-reconciliation-124.1';

INSERT INTO app.schema_migrations(version,description)
VALUES('0124-clean-document-scan-reconciliation',
  'Reconcile only previously verified documents after a current matching CLEAN malware scan')
ON CONFLICT(version) DO NOTHING;

COMMIT;
