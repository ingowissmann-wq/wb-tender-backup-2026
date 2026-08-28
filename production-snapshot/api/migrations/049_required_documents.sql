CREATE TABLE IF NOT EXISTS tender.required_documents(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tender.tenders(id),
  tender_version_id uuid,
  lot_key text NOT NULL DEFAULT '',
  company_id uuid NOT NULL,
  requirement_code text NOT NULL,
  requirement_title text NOT NULL,
  requirement_description text NOT NULL,
  source_document_id uuid,
  source_page integer,
  source_reference text NOT NULL,
  category text NOT NULL,
  document_type text NOT NULL,
  mandatory boolean NOT NULL DEFAULT true,
  submission_relevant boolean NOT NULL DEFAULT true,
  approval_relevant boolean NOT NULL DEFAULT false,
  expected_signatories jsonb NOT NULL DEFAULT '[]'::jsonb,
  signature_required boolean NOT NULL DEFAULT false,
  signature_type text,
  expected_date date,
  valid_from date,
  valid_until date,
  accepted_formats text[] NOT NULL DEFAULT ARRAY['application/pdf'],
  max_file_size bigint NOT NULL DEFAULT 20971520 CHECK(max_file_size>0),
  portal_upload_category text,
  portal_field_id text,
  satisfaction_status text NOT NULL DEFAULT 'MISSING',
  source_type text NOT NULL,
  reusable_company_evidence boolean NOT NULL DEFAULT false,
  current_upload_id uuid,
  not_required_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tender_id,tender_version_id,lot_key,company_id,requirement_code),
  CHECK(satisfaction_status IN('MISSING','AVAILABLE','UPLOADED_PENDING_VALIDATION','MANUAL_REVIEW_REQUIRED','VALIDATED','REJECTED','NOT_REQUIRED','SUPERSEDED')),
  CHECK(source_type IN('TENDER_DOCUMENT','PORTAL_FORM','CRITERIA_CATALOG','COMPANY_EVIDENCE','MANUAL')),
  CHECK(NOT (satisfaction_status='NOT_REQUIRED' AND nullif(not_required_reason,'') IS NULL))
);
ALTER TABLE tender.required_documents ADD COLUMN IF NOT EXISTS reusable_company_evidence boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS tender.required_document_company_evidence_links(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  required_document_id uuid NOT NULL REFERENCES tender.required_documents(id),
  evidence_item_id uuid NOT NULL REFERENCES tender.evidence_items(id),
  matched_by text NOT NULL,
  matched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(required_document_id,evidence_item_id)
);

CREATE TABLE IF NOT EXISTS tender.required_document_uploads(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  required_document_id uuid NOT NULL REFERENCES tender.required_documents(id),
  tender_id uuid NOT NULL REFERENCES tender.tenders(id),
  lot_key text NOT NULL DEFAULT '',
  company_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),
  filename text NOT NULL,
  media_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK(size_bytes>0),
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  content bytea NOT NULL,
  source_type text NOT NULL DEFAULT 'MANUAL_UPLOAD',
  validation_status text NOT NULL DEFAULT 'UPLOADED_PENDING_VALIDATION',
  validation_summary text,
  validation_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  malware_scan_status text NOT NULL DEFAULT 'NOT_AVAILABLE',
  is_current boolean NOT NULL DEFAULT true,
  uploaded_by uuid NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  UNIQUE(required_document_id,version),
  CHECK(validation_status IN('UPLOADED_PENDING_VALIDATION','MANUAL_REVIEW_REQUIRED','VALIDATED','REJECTED')),
  CHECK(source_type IN('MANUAL_UPLOAD','COMPANY_EVIDENCE'))
);
CREATE UNIQUE INDEX IF NOT EXISTS required_document_upload_current
  ON tender.required_document_uploads(required_document_id) WHERE is_current;

ALTER TABLE tender.required_documents DROP CONSTRAINT IF EXISTS required_documents_current_upload_fk;
ALTER TABLE tender.required_documents ADD CONSTRAINT required_documents_current_upload_fk
  FOREIGN KEY(current_upload_id) REFERENCES tender.required_document_uploads(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS tender.required_document_package_bindings(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  required_document_id uuid NOT NULL REFERENCES tender.required_documents(id),
  upload_id uuid NOT NULL REFERENCES tender.required_document_uploads(id),
  bid_package_id uuid NOT NULL REFERENCES tender.bid_packages(id),
  binding_type text NOT NULL,
  portal_upload_category text,
  portal_field_id text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(upload_id,bid_package_id),
  CHECK(binding_type IN('SUPPLEMENTAL_EVIDENCE','NEW_PACKAGE_REVISION_REQUIRED'))
);

CREATE TABLE IF NOT EXISTS tender.required_document_rechecks(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  required_document_id uuid NOT NULL REFERENCES tender.required_documents(id),
  trigger_upload_id uuid REFERENCES tender.required_document_uploads(id),
  required_document_status text NOT NULL,
  bid_package_status text NOT NULL,
  portal_mapping_status text NOT NULL,
  submission_gate_status text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS required_documents_context_idx
  ON tender.required_documents(tender_id,company_id,lot_key,satisfaction_status);
CREATE INDEX IF NOT EXISTS required_documents_inbox_idx
  ON tender.required_documents(satisfaction_status,mandatory,submission_relevant);

COMMENT ON TABLE tender.required_documents IS 'Tender-, los- und gesellschaftsgebundene Pflichtunterlagen; nur VALIDATED oder begruendet NOT_REQUIRED passieren das Submission Gate.';
COMMENT ON TABLE tender.required_document_uploads IS 'Unveraenderliche Uploadversionen. Ein generischer Upload erfuellt nie ohne konkrete Requirement-Validierung einen Pflichtnachweis.';

-- Requirements are deliberately not seeded here. They are discovered from the
-- concrete tender documents and the concrete portal submission schema.
