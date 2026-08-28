CREATE TABLE IF NOT EXISTS tender.required_document_working_copies(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  required_document_id uuid NOT NULL REFERENCES tender.required_documents(id),
  tender_id uuid NOT NULL REFERENCES tender.tenders(id),
  lot_key text NOT NULL DEFAULT '',
  company_id uuid NOT NULL,
  source_document_id uuid NOT NULL REFERENCES tender.enrichment_documents(id),
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
  version integer NOT NULL CHECK(version>0),
  filename text NOT NULL,
  media_type text NOT NULL,
  content bytea NOT NULL,
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  original_unchanged boolean NOT NULL DEFAULT true CHECK(original_unchanged=true),
  legal_confirmation_added boolean NOT NULL DEFAULT false CHECK(legal_confirmation_added=false),
  is_current boolean NOT NULL DEFAULT true,
  prepared_by uuid NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(required_document_id,version)
);
CREATE UNIQUE INDEX IF NOT EXISTS required_document_working_copy_current
  ON tender.required_document_working_copies(required_document_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS required_document_working_copy_scope
  ON tender.required_document_working_copies(tender_id,company_id,lot_key,required_document_id);

COMMENT ON TABLE tender.required_document_working_copies IS
  'Versionierte interne Arbeitskopien exakt belegter Originalformulare; unveränderte Quelle, keine Signatur, Erklärung oder externe Übertragung.';
