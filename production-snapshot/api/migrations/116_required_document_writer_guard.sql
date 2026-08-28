BEGIN;

CREATE OR REPLACE FUNCTION tender.guard_required_document_classification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.mandatory AND NEW.submission_relevant
     AND NEW.requirement_classification IS NULL
     AND NEW.satisfaction_status<>'SUPERSEDED' THEN
    NEW.requirement_classification:='REVIEW_REQUIRED';
    NEW.satisfaction_status:='MANUAL_REVIEW_REQUIRED';
    NEW.classification_reason:='Authoritative classification evidence is incomplete; explicit human review required.';
    NEW.classification_provenance:=coalesce(NEW.classification_provenance,'{}'::jsonb)
      || jsonb_build_object('classificationSource','FAIL_CLOSED_WRITER_GUARD','invented',false,'guardedAt',now());
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS required_document_classification_writer_guard ON tender.required_documents;
CREATE TRIGGER required_document_classification_writer_guard
BEFORE INSERT OR UPDATE OF mandatory,submission_relevant,requirement_classification,satisfaction_status
ON tender.required_documents
FOR EACH ROW EXECUTE FUNCTION tender.guard_required_document_classification();

UPDATE tender.required_documents
SET requirement_classification='REVIEW_REQUIRED',
    satisfaction_status='MANUAL_REVIEW_REQUIRED',
    classification_reason='Authoritative classification evidence is incomplete; explicit human review required.',
    classification_provenance=coalesce(classification_provenance,'{}'::jsonb)
      || jsonb_build_object('classificationSource','FAIL_CLOSED_WRITER_GUARD_RECONCILIATION','invented',false,'guardedAt',now()),
    updated_at=now()
WHERE mandatory AND submission_relevant
  AND requirement_classification IS NULL
  AND satisfaction_status<>'SUPERSEDED';

COMMIT;
