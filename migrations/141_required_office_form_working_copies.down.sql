BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:required-office-form-working-copies:141',0));

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM tender.required_document_uploads WHERE source_type='REQUIRED_OFFICE_WORKING_COPY') THEN
    RAISE EXCEPTION 'cannot roll back migration 141 while Office working-copy uploads exist';
  END IF;
END $$;

ALTER TABLE tender.required_document_uploads
  DROP CONSTRAINT IF EXISTS required_document_uploads_source_type_check;
ALTER TABLE tender.required_document_uploads
  ADD CONSTRAINT required_document_uploads_source_type_check
  CHECK(source_type IN('MANUAL_UPLOAD','COMPANY_EVIDENCE','REQUIRED_PDF_WORKING_COPY'));

COMMENT ON COLUMN tender.required_document_uploads.source_working_copy_id IS
  'Exact immutable PDF working-copy version represented by this reviewable required-document upload.';

DELETE FROM app.schema_migrations WHERE version='0141-required-office-form-working-copies';

COMMIT;
