BEGIN;

DO $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM pg_constraint
    WHERE conrelid='tender.required_documents'::regclass
      AND conname='required_documents_classification_chk'
      AND pg_get_constraintdef(oid) LIKE '%REVIEW_REQUIRED%'
  ) THEN
    ALTER TABLE tender.required_documents
      ADD CONSTRAINT required_documents_classification_review_chk
      CHECK(requirement_classification IS NULL OR requirement_classification IN(
        'FILLABLE_BIDDER_FORM','BID_TIME_UPLOAD_EVIDENCE','POST_AWARD_EVIDENCE',
        'CONTRACT_PERFORMANCE_CLAUSE','INFORMATIONAL_TEXT','REVIEW_REQUIRED'
      )) NOT VALID;
    ALTER TABLE tender.required_documents
      DROP CONSTRAINT required_documents_classification_chk;
    ALTER TABLE tender.required_documents
      RENAME CONSTRAINT required_documents_classification_review_chk
      TO required_documents_classification_chk;
  END IF;
END $$;

UPDATE tender.required_documents
SET requirement_classification='REVIEW_REQUIRED',
    satisfaction_status='MANUAL_REVIEW_REQUIRED',
    classification_reason='Authoritative classification evidence is incomplete; explicit human review required.',
    classification_provenance=coalesce(classification_provenance,'{}'::jsonb)
      || jsonb_build_object('classificationSource','FAIL_CLOSED_RECONCILIATION','invented',false,'reconciledAt',now()),
    updated_at=now()
WHERE mandatory AND submission_relevant
  AND requirement_classification IS NULL
  AND satisfaction_status<>'SUPERSEDED';

ALTER TABLE tender.required_documents
  VALIDATE CONSTRAINT required_documents_classification_chk;

COMMIT;
