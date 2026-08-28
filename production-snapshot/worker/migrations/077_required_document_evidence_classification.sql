BEGIN;

ALTER TABLE tender.required_documents
  ADD COLUMN IF NOT EXISTS requirement_classification text,
  ADD COLUMN IF NOT EXISTS classification_reason text,
  ADD COLUMN IF NOT EXISTS classification_provenance jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE tender.final_preflight_requirements
  ADD COLUMN IF NOT EXISTS requirement_classification text,
  ADD COLUMN IF NOT EXISTS classification_reason text,
  ADD COLUMN IF NOT EXISTS classification_provenance jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='required_documents_classification_chk') THEN
    ALTER TABLE tender.required_documents ADD CONSTRAINT required_documents_classification_chk
      CHECK (requirement_classification IS NULL OR requirement_classification IN
        ('FILLABLE_BIDDER_FORM','BID_TIME_UPLOAD_EVIDENCE','POST_AWARD_EVIDENCE','CONTRACT_PERFORMANCE_CLAUSE','INFORMATIONAL_TEXT'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='final_preflight_requirements_classification_chk') THEN
    ALTER TABLE tender.final_preflight_requirements ADD CONSTRAINT final_preflight_requirements_classification_chk
      CHECK (requirement_classification IS NULL OR requirement_classification IN
        ('FILLABLE_BIDDER_FORM','BID_TIME_UPLOAD_EVIDENCE','POST_AWARD_EVIDENCE','CONTRACT_PERFORMANCE_CLAUSE','INFORMATIONAL_TEXT'));
  END IF;
END $$;

COMMIT;
