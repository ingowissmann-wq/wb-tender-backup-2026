BEGIN;

ALTER TABLE tender.required_documents
  ADD COLUMN IF NOT EXISTS manual_submission_relevance_override boolean,
  ADD COLUMN IF NOT EXISTS manual_submission_relevance_override_at timestamptz,
  ADD COLUMN IF NOT EXISTS manual_submission_relevance_override_by uuid;

ALTER TABLE tender.final_preflight_requirements
  ADD COLUMN IF NOT EXISTS manual_submission_relevance_override boolean;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='required_documents_manual_submission_relevance_chk') THEN
    ALTER TABLE tender.required_documents ADD CONSTRAINT required_documents_manual_submission_relevance_chk
      CHECK (manual_submission_relevance_override IS NULL OR manual_submission_relevance_override=false);
  END IF;
END $$;

COMMENT ON COLUMN tender.required_documents.manual_submission_relevance_override IS
  'NULL: no human override; FALSE: an authorized human explicitly confirmed this assignment is not required for bid submission. This is not evidence validation.';

COMMIT;
