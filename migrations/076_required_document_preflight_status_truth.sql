ALTER TABLE tender.final_preflight_requirements
  DROP CONSTRAINT IF EXISTS final_preflight_requirements_status_check;

ALTER TABLE tender.final_preflight_requirements
  ADD CONSTRAINT final_preflight_requirements_status_check
  CHECK(status IN(
    'MISSING','AVAILABLE','UPLOADED_PENDING_VALIDATION','USER_INPUT_REQUIRED',
    'USER_CONFIRMATION_REQUIRED','MANAGEMENT_REVIEW_REQUIRED','MANUAL_REVIEW_REQUIRED',
    'VALIDATED','REJECTED','NOT_REQUIRED','SUPERSEDED'
  ));

COMMENT ON COLUMN tender.final_preflight_requirements.status IS
  'Requirement lifecycle including distinct missing, rejected, validation/review-ready and completed states.';

ALTER TABLE tender.required_document_uploads
  ADD COLUMN IF NOT EXISTS source_working_copy_id uuid REFERENCES tender.required_document_working_copies(id);

ALTER TABLE tender.required_document_uploads
  DROP CONSTRAINT IF EXISTS required_document_uploads_source_type_check;
ALTER TABLE tender.required_document_uploads
  ADD CONSTRAINT required_document_uploads_source_type_check
  CHECK(source_type IN('MANUAL_UPLOAD','COMPANY_EVIDENCE','REQUIRED_PDF_WORKING_COPY'));

CREATE UNIQUE INDEX IF NOT EXISTS required_document_upload_working_copy
  ON tender.required_document_uploads(source_working_copy_id) WHERE source_working_copy_id IS NOT NULL;

COMMENT ON COLUMN tender.required_document_uploads.source_working_copy_id IS
  'Exact immutable PDF working-copy version represented by this reviewable required-document upload.';
