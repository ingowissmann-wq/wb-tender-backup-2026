BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='10min';

ALTER TABLE tender.tenders
  ADD COLUMN IF NOT EXISTS notice_classification text,
  ADD COLUMN IF NOT EXISTS participation_status text,
  ADD COLUMN IF NOT EXISTS participation_block_reason text,
  ADD COLUMN IF NOT EXISTS notice_type_code text,
  ADD COLUMN IF NOT EXISTS notice_subtype text,
  ADD COLUMN IF NOT EXISTS notice_form_type text,
  ADD COLUMN IF NOT EXISTS procedure_identifier text;

ALTER TABLE tender.tenders
  DROP CONSTRAINT IF EXISTS tenders_source_lifecycle_status_chk,
  DROP CONSTRAINT IF EXISTS tenders_notice_classification_chk,
  DROP CONSTRAINT IF EXISTS tenders_participation_status_chk;
ALTER TABLE tender.tenders
  ADD CONSTRAINT tenders_source_lifecycle_status_chk CHECK(source_lifecycle_status IN('ACTIVE','EXPIRED','WITHDRAWN','TOMBSTONED','CLOSED','REVIEW_REQUIRED')) NOT VALID,
  ADD CONSTRAINT tenders_notice_classification_chk CHECK(notice_classification IS NULL OR notice_classification IN('COMPETITION','CORRIGENDUM','PRIOR_INFORMATION','RESULT','CONTRACT_MODIFICATION','CANCELLATION','VOLUNTARY_EX_ANTE','UNKNOWN')) NOT VALID,
  ADD CONSTRAINT tenders_participation_status_chk CHECK(participation_status IS NULL OR participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE','NOT_ELIGIBLE','REVIEW_REQUIRED')) NOT VALID;
ALTER TABLE tender.tenders VALIDATE CONSTRAINT tenders_source_lifecycle_status_chk;
ALTER TABLE tender.tenders VALIDATE CONSTRAINT tenders_notice_classification_chk;
ALTER TABLE tender.tenders VALIDATE CONSTRAINT tenders_participation_status_chk;

CREATE TABLE tender.tender_deadline_evidence(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tender.tenders(id),
  source_code text NOT NULL CHECK(source_code IN('TED','DOE')),
  source_notice_id text NOT NULL,
  procedure_identifier text,
  lot_key text,
  deadline_type text NOT NULL CHECK(deadline_type IN('TENDER_RECEIPT','PARTICIPATION_REQUEST')),
  source_date text,
  source_time text,
  source_timezone text,
  normalized_utc timestamptz,
  europe_berlin text,
  source_timestamp timestamptz,
  source_version text,
  source_kind text NOT NULL,
  parsing_status text NOT NULL CHECK(parsing_status IN('EXACT','DATE_ONLY','MISSING','INVALID','AMBIGUOUS','UNBOUND')),
  decision_reason text NOT NULL,
  date_only boolean NOT NULL DEFAULT false,
  evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
  raw_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tender_id,evidence_sha256),
  CHECK((parsing_status='EXACT')=(normalized_utc IS NOT NULL)),
  CHECK(NOT date_only OR source_time IS NULL)
);
CREATE INDEX tender_deadline_evidence_current_exact_idx
  ON tender.tender_deadline_evidence(tender_id,lot_key,deadline_type)
  WHERE is_current AND parsing_status='EXACT' AND lot_key IS NOT NULL;
CREATE INDEX tender_deadline_evidence_tender_idx ON tender.tender_deadline_evidence(tender_id,is_current,lot_key);

CREATE TABLE tender.tender_lot_lifecycles(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tender.tenders(id),
  lot_key text NOT NULL,
  lifecycle_status text NOT NULL CHECK(lifecycle_status IN('ACTIVE','EXPIRED','WITHDRAWN','CLOSED','REVIEW_REQUIRED')),
  participation_status text NOT NULL CHECK(participation_status IN('ELIGIBLE','NOT_ELIGIBLE','REVIEW_REQUIRED')),
  participation_block_reason text,
  offer_deadline timestamptz,
  deadline_quality text NOT NULL,
  deadline_evidence_id uuid REFERENCES tender.tender_deadline_evidence(id),
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tender_id,lot_key),
  CHECK(participation_status<>'ELIGIBLE' OR (lifecycle_status='ACTIVE' AND offer_deadline IS NOT NULL AND deadline_quality='EXACT'))
);
CREATE INDEX tender_lot_lifecycles_participation_idx ON tender.tender_lot_lifecycles(tender_id,participation_status,offer_deadline) WHERE is_current;
CREATE INDEX tender_lot_lifecycles_deadline_evidence_idx ON tender.tender_lot_lifecycles(deadline_evidence_id) WHERE deadline_evidence_id IS NOT NULL;

CREATE TABLE tender.tender_notice_relationships(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_tender_id uuid NOT NULL REFERENCES tender.tenders(id),
  related_tender_id uuid REFERENCES tender.tenders(id),
  source_code text NOT NULL CHECK(source_code IN('TED','DOE')),
  source_external_id text NOT NULL,
  related_external_id text NOT NULL,
  procedure_identifier text,
  relationship_type text NOT NULL CHECK(relationship_type IN('PREVIOUS_NOTICE','CORRECTS','RESULT_OF','CANCELS','MODIFIES','RELATED')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_tender_id,related_external_id,relationship_type)
);
CREATE INDEX tender_notice_relationships_related_idx ON tender.tender_notice_relationships(related_tender_id,relationship_type);
CREATE INDEX tender_notice_relationships_procedure_idx ON tender.tender_notice_relationships(source_code,procedure_identifier) WHERE procedure_identifier IS NOT NULL;

CREATE TABLE tender.notice_lifecycle_correction_runs(
  run_id uuid PRIMARY KEY,
  plan_sha256 text NOT NULL UNIQUE CHECK(plan_sha256 ~ '^[0-9a-f]{64}$'),
  input_sha256 text NOT NULL CHECK(input_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK(status IN('PREPARED','APPLIED','ROLLED_BACK','FAILED')),
  planned_row_count integer NOT NULL CHECK(planned_row_count>=0),
  lifecycle_transition_count integer NOT NULL CHECK(lifecycle_transition_count>=0),
  plan_document jsonb NOT NULL,
  as_of timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz, rolled_back_at timestamptz
);

CREATE TABLE tender.notice_lifecycle_correction_rows(
  run_id uuid NOT NULL REFERENCES tender.notice_lifecycle_correction_runs(run_id),
  tender_id uuid NOT NULL REFERENCES tender.tenders(id),
  previous_tender jsonb NOT NULL,
  previous_deadline_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  previous_lot_lifecycles jsonb NOT NULL DEFAULT '[]'::jsonb,
  previous_relationships jsonb NOT NULL DEFAULT '[]'::jsonb,
  applied_tender jsonb NOT NULL,
  applied_deadline_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  applied_lot_lifecycles jsonb NOT NULL DEFAULT '[]'::jsonb,
  applied_relationships jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_plan_sha256 text NOT NULL CHECK(row_plan_sha256 ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id,tender_id)
);
CREATE INDEX notice_lifecycle_correction_rows_tender_idx ON tender.notice_lifecycle_correction_rows(tender_id,run_id);

CREATE TABLE tender.notice_lifecycle_transitions(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tender_id uuid NOT NULL REFERENCES tender.tenders(id),
  correction_run_id uuid REFERENCES tender.notice_lifecycle_correction_runs(run_id),
  lot_key text,
  from_lifecycle text, to_lifecycle text NOT NULL,
  from_participation text, to_participation text NOT NULL,
  reason_code text, evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notice_lifecycle_transitions_tender_idx ON tender.notice_lifecycle_transitions(tender_id,occurred_at DESC);
CREATE INDEX notice_lifecycle_transitions_run_idx ON tender.notice_lifecycle_transitions(correction_run_id) WHERE correction_run_id IS NOT NULL;

REVOKE ALL ON tender.notice_lifecycle_correction_runs FROM PUBLIC;
REVOKE ALL ON tender.notice_lifecycle_correction_rows FROM PUBLIC;

CREATE VIEW tender.current_participation_eligible_lots WITH(security_barrier=true) AS
SELECT t.id tender_id,t.source_code,t.external_id,t.notice_classification,t.source_lifecycle_status tender_lifecycle_status,
  t.participation_status tender_participation_status,lot.lot_key,lot.lifecycle_status,lot.participation_status,
  lot.offer_deadline,lot.deadline_quality
FROM tender.tenders t JOIN tender.tender_lot_lifecycles lot ON lot.tender_id=t.id AND lot.is_current
WHERE t.data_class='PUBLIC_REAL' AND t.source_lifecycle_status='ACTIVE'
  AND t.participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE')
  AND t.notice_classification IN('COMPETITION','CORRIGENDUM')
  AND lot.lifecycle_status='ACTIVE' AND lot.participation_status='ELIGIBLE'
  AND lot.deadline_quality='EXACT' AND lot.offer_deadline>now();

CREATE VIEW tender.current_participation_eligible_tenders WITH(security_barrier=true) AS
SELECT t.* FROM tender.tenders t
WHERE t.data_class='PUBLIC_REAL' AND EXISTS(
  SELECT 1 FROM tender.current_participation_eligible_lots lot WHERE lot.tender_id=t.id
);

COMMENT ON VIEW tender.current_participation_eligible_lots IS 'Fail-closed participation scope bound to an exact, unexpired, authoritative lot deadline.';
COMMENT ON COLUMN tender.tenders.offer_deadline IS 'Aggregate display deadline only; participation authorization is exclusively lot-bound through current_participation_eligible_lots.';
COMMIT;
