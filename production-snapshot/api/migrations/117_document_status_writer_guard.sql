BEGIN;

CREATE OR REPLACE FUNCTION tender.guard_enrichment_document_status_truth()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.procurement_verification_status='VERIFIED'
     AND NEW.fetch_status IN('DOWNLOAD_FEHLGESCHLAGEN','PARSER_FEHLER') THEN
    NEW.procurement_verification_status:='REVIEW_REQUIRED';
    NEW.provenance:=coalesce(NEW.provenance,'{}'::jsonb)
      || jsonb_build_object('statusGuard','FETCH_OR_PARSER_FAILURE','invented',false,'guardedAt',now());
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS enrichment_document_status_truth_writer_guard ON tender.enrichment_documents;
CREATE TRIGGER enrichment_document_status_truth_writer_guard
BEFORE INSERT OR UPDATE OF procurement_verification_status,fetch_status
ON tender.enrichment_documents
FOR EACH ROW EXECUTE FUNCTION tender.guard_enrichment_document_status_truth();

UPDATE tender.enrichment_documents
SET procurement_verification_status='REVIEW_REQUIRED',
    provenance=coalesce(provenance,'{}'::jsonb)
      || jsonb_build_object('statusGuard','FETCH_OR_PARSER_FAILURE_RECONCILIATION','invented',false,'guardedAt',now())
WHERE procurement_verification_status='VERIFIED'
  AND fetch_status IN('DOWNLOAD_FEHLGESCHLAGEN','PARSER_FEHLER');

COMMIT;
