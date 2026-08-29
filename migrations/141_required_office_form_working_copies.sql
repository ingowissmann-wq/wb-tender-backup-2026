BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:required-office-form-working-copies:141',0));

ALTER TABLE tender.required_document_uploads
  DROP CONSTRAINT IF EXISTS required_document_uploads_source_type_check;
ALTER TABLE tender.required_document_uploads
  ADD CONSTRAINT required_document_uploads_source_type_check
  CHECK(source_type IN('MANUAL_UPLOAD','COMPANY_EVIDENCE','REQUIRED_PDF_WORKING_COPY','REQUIRED_OFFICE_WORKING_COPY'));

COMMENT ON COLUMN tender.required_document_uploads.source_working_copy_id IS
  'Exact immutable PDF/DOCX/XLSX working-copy version represented by this reviewable required-document upload.';

INSERT INTO app.schema_migrations(version,description)
VALUES('0141-required-office-form-working-copies',
  'Permit verified versioned DOCX/XLSX form working copies with mandatory human visual review')
ON CONFLICT(version) DO NOTHING;

COMMIT;
