-- Internal orchestration and read-only portal feedback.  This migration cannot
-- enable or record an external transmission.
CREATE TABLE IF NOT EXISTS tender.submission_package_manifests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_context_id uuid NOT NULL REFERENCES tender.submission_contexts(id),
  manifest_version integer NOT NULL CHECK(manifest_version>0),
  manifest jsonb NOT NULL,
  manifest_sha256 text NOT NULL CHECK(manifest_sha256~'^[0-9a-f]{64}$'),
  approval_request_id uuid NOT NULL REFERENCES tender.approval_requests(id),
  binding_sha256 text NOT NULL CHECK(binding_sha256~'^[0-9a-f]{64}$'),
  transmitted boolean NOT NULL DEFAULT false CHECK(transmitted=false),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(submission_context_id,manifest_version),
  UNIQUE(submission_context_id,manifest_sha256)
);

CREATE OR REPLACE FUNCTION tender.reject_immutable_submission_manifest() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='submission package manifest is immutable';
END $$;
DROP TRIGGER IF EXISTS submission_package_manifest_immutable ON tender.submission_package_manifests;
CREATE TRIGGER submission_package_manifest_immutable BEFORE UPDATE OR DELETE ON tender.submission_package_manifests
FOR EACH ROW EXECUTE FUNCTION tender.reject_immutable_submission_manifest();

CREATE TABLE IF NOT EXISTS tender.portal_inbound_events(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_context_id uuid REFERENCES tender.submission_contexts(id),
  tender_id uuid NOT NULL REFERENCES tender.tenders(id),
  company_id uuid NOT NULL,
  lot_key text NOT NULL DEFAULT '',
  portal_id uuid NOT NULL REFERENCES tender.portal_registry(id),
  credential_id uuid,
  event_type text NOT NULL CHECK(event_type IN('RECEIPT','STATUS','MESSAGE','AMENDMENT','AWARD','REJECTION','CANCELLATION')),
  external_event_id text NOT NULL CHECK(length(external_event_id) BETWEEN 1 AND 200),
  source_mode text NOT NULL CHECK(source_mode IN('READ_ONLY_POLL','VERIFIED_WEBHOOK','MANUAL_VERIFIED_IMPORT','ACCEPTANCE_SANDBOX')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_sha256 text NOT NULL CHECK(event_sha256~'^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL UNIQUE CHECK(idempotency_key~'^[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  external_write boolean NOT NULL DEFAULT false CHECK(external_write=false),
  transmitted boolean NOT NULL DEFAULT false CHECK(transmitted=false),
  CHECK(submission_context_id IS NOT NULL OR event_type<>'RECEIPT')
);
CREATE INDEX IF NOT EXISTS portal_inbound_scope_history ON tender.portal_inbound_events(tender_id,company_id,lot_key,observed_at DESC);

CREATE TABLE IF NOT EXISTS tender.submission_reconciliation_jobs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_context_id uuid NOT NULL REFERENCES tender.submission_contexts(id),
  job_kind text NOT NULL CHECK(job_kind IN('READ_ONLY_STATUS_POLL','RECEIPT_RECONCILIATION','MESSAGE_POLL','AMENDMENT_POLL','OUTCOME_POLL')),
  status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','RUNNING','RETRY_WAIT','SUCCEEDED','DEAD_LETTER','CANCELLED')),
  attempt integer NOT NULL DEFAULT 0 CHECK(attempt>=0),
  max_attempts integer NOT NULL DEFAULT 6 CHECK(max_attempts BETWEEN 1 AND 20),
  idempotency_key text NOT NULL UNIQUE CHECK(idempotency_key~'^[0-9a-f]{64}$'),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,lease_expires_at timestamptz,
  last_error_class text,last_error_safe text,
  external_write boolean NOT NULL DEFAULT false CHECK(external_write=false),
  transmitted boolean NOT NULL DEFAULT false CHECK(transmitted=false),
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS submission_reconciliation_claim ON tender.submission_reconciliation_jobs(status,next_attempt_at) WHERE status IN('QUEUED','RETRY_WAIT');

CREATE OR REPLACE VIEW tender.current_submission_feedback AS
SELECT event.tender_id,event.company_id,event.lot_key,event.submission_context_id,
  max(event.observed_at) last_observed_at,
  count(*) FILTER(WHERE event.event_type='MESSAGE')::int message_count,
  count(*) FILTER(WHERE event.event_type='AMENDMENT')::int amendment_count,
  (array_agg(event.event_type ORDER BY event.observed_at DESC,event.received_at DESC))[1] latest_event_type,
  false AS transmitted
FROM tender.portal_inbound_events event
GROUP BY event.tender_id,event.company_id,event.lot_key,event.submission_context_id;

COMMENT ON TABLE tender.portal_inbound_events IS 'Inbound read-only portal observations; never proves that WB transmitted a bid.';
COMMENT ON TABLE tender.submission_reconciliation_jobs IS 'Read-only polling/reconciliation jobs only; binding portal execution is outside this table and HTTP 423 locked.';
