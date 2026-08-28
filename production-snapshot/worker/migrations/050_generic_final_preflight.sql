CREATE TABLE IF NOT EXISTS tender.final_preflight_contexts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tender.tenders(id),
  tender_version_id uuid NOT NULL REFERENCES tender.tender_versions(id),
  lot_key text NOT NULL DEFAULT '',
  company_id uuid NOT NULL,
  service_line text,
  document_revision_sha256 text,
  calculation_id uuid REFERENCES tender.calculations(id),
  management_output_id uuid REFERENCES tender.management_outputs(id),
  approval_request_id uuid REFERENCES tender.approval_requests(id),
  bid_package_id uuid REFERENCES tender.bid_packages(id),
  submission_context_id uuid REFERENCES tender.submission_contexts(id),
  portal_session_id uuid REFERENCES tender.portal_read_sessions(id),
  binding_valid boolean NOT NULL DEFAULT false,
  schema_version integer NOT NULL DEFAULT 1,
  schema_sha256 text,
  readiness_status text NOT NULL DEFAULT 'DISCOVERY_PENDING',
  transmitted boolean NOT NULL DEFAULT false,
  is_current boolean NOT NULL DEFAULT true,
  discovered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(readiness_status IN('DISCOVERY_PENDING','PACKAGE_INCOMPLETE','WAITING_FOR_USER_INPUT','MANAGEMENT_REVIEW_REQUIRED','PREFLIGHT_READY')),
  CHECK(transmitted=false)
);
CREATE UNIQUE INDEX IF NOT EXISTS final_preflight_context_current
  ON tender.final_preflight_contexts(tender_id,lot_key,company_id) WHERE is_current;

CREATE TABLE IF NOT EXISTS tender.final_preflight_requirements(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context_id uuid NOT NULL REFERENCES tender.final_preflight_contexts(id),
  requirement_key text NOT NULL,
  requirement_kind text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  source_type text NOT NULL,
  source_document_id uuid,
  source_page integer,
  source_reference text NOT NULL,
  source_excerpt text NOT NULL,
  source_evidence_sha256 text NOT NULL,
  scope_type text NOT NULL DEFAULT 'LOT',
  category text,
  field_type text,
  possible_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  mandatory boolean NOT NULL DEFAULT true,
  submission_relevant boolean NOT NULL DEFAULT true,
  human_action_required boolean NOT NULL DEFAULT false,
  legal_confirmation_required boolean NOT NULL DEFAULT false,
  action_group text NOT NULL,
  status text NOT NULL DEFAULT 'MISSING',
  due_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(context_id,requirement_key,source_evidence_sha256),
  CHECK(requirement_kind IN('REQUIRED_DOCUMENT','MISSING_INPUT','USER_CONFIRMATION','MANAGEMENT_REVIEW','PRICE_FIELD','PORTAL_FORM','CONCEPT','REFERENCE','SIGNATURE','PORTAL_BLOCKER')),
  CHECK(source_type IN('TENDER_DOCUMENT','PORTAL_FORM','PORTAL_VALIDATION','CONTRACTING_AUTHORITY_INFORMATION')),
  CHECK(scope_type IN('LOT','PROCEDURE')),
  CHECK(action_group IN('MISSING_DOCUMENT','COMPANY_INPUT','PRICE_CALCULATION','CONCEPT','PORTAL_FORM','LEGAL_CONFIRMATION','SIGNATURE','PORTAL_BLOCKER')),
  CHECK(status IN('MISSING','AVAILABLE','USER_INPUT_REQUIRED','USER_CONFIRMATION_REQUIRED','MANAGEMENT_REVIEW_REQUIRED','MANUAL_REVIEW_REQUIRED','VALIDATED','NOT_REQUIRED','SUPERSEDED'))
);
CREATE INDEX IF NOT EXISTS final_preflight_requirements_context_status
  ON tender.final_preflight_requirements(context_id,status,submission_relevant);

CREATE TABLE IF NOT EXISTS tender.final_preflight_user_actions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context_id uuid NOT NULL REFERENCES tender.final_preflight_contexts(id),
  requirement_id uuid NOT NULL REFERENCES tender.final_preflight_requirements(id),
  action_type text NOT NULL,
  display_title text NOT NULL,
  instruction text NOT NULL,
  priority text NOT NULL DEFAULT 'NORMAL',
  status text NOT NULL DEFAULT 'OPEN',
  due_at timestamptz,
  completed_by uuid,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(requirement_id,action_type),
  CHECK(priority IN('NORMAL','HIGH','CRITICAL')),
  CHECK(status IN('OPEN','IN_PROGRESS','COMPLETED','CANCELLED'))
);

CREATE TABLE IF NOT EXISTS tender.portal_submission_schemas(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context_id uuid NOT NULL REFERENCES tender.final_preflight_contexts(id),
  portal_id uuid,
  submission_context_id uuid REFERENCES tender.submission_contexts(id),
  schema_version integer NOT NULL,
  schema_sha256 text NOT NULL,
  schema_payload jsonb NOT NULL,
  source_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  authoritative boolean NOT NULL DEFAULT false,
  is_current boolean NOT NULL DEFAULT true,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(context_id,schema_version)
);
CREATE UNIQUE INDEX IF NOT EXISTS portal_submission_schema_current
  ON tender.portal_submission_schemas(context_id) WHERE is_current;

CREATE TABLE IF NOT EXISTS tender.package_readiness_checks(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context_id uuid NOT NULL REFERENCES tender.final_preflight_contexts(id),
  bid_package_id uuid REFERENCES tender.bid_packages(id),
  status text NOT NULL,
  blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
  binding_valid boolean NOT NULL,
  portal_mapping_complete boolean NOT NULL DEFAULT false,
  required_documents_complete boolean NOT NULL DEFAULT false,
  human_actions_complete boolean NOT NULL DEFAULT false,
  transmitted boolean NOT NULL DEFAULT false,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(status IN('PACKAGE_INCOMPLETE','WAITING_FOR_USER_INPUT','MANAGEMENT_REVIEW_REQUIRED','PREFLIGHT_READY')),
  CHECK(transmitted=false)
);

CREATE OR REPLACE VIEW tender.current_final_preflight_contexts AS
SELECT c.*,t.title,t.offer_deadline,e.legal_name company_name
FROM tender.final_preflight_contexts c
JOIN tender.tenders t ON t.id=c.tender_id
JOIN tender.enterprise_company_links e ON e.company_id=c.company_id
WHERE c.is_current;

COMMENT ON TABLE tender.final_preflight_requirements IS 'Concrete, source-evidenced requirements. Service line and document class never create a requirement.';
COMMENT ON TABLE tender.portal_submission_schemas IS 'Tender-, lot-, company- and submission-context-specific live portal schema; adapters only provide technical extraction.';
