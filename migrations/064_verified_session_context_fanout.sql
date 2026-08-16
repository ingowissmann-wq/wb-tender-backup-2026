BEGIN;

CREATE TABLE IF NOT EXISTS tender.portal_session_context_dispatches(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES tender.portal_read_sessions(id) ON DELETE CASCADE,
  tender_id uuid NOT NULL REFERENCES tender.tenders(id),
  company_id uuid NOT NULL,
  lot_key text NOT NULL DEFAULT '',
  portal_id uuid NOT NULL REFERENCES tender.portal_registry(id),
  credential_id uuid NOT NULL REFERENCES tender.portal_credential_secrets(id),
  job_id uuid REFERENCES tender.autopilot_queue(id),
  dispatch_status text NOT NULL DEFAULT 'PLANNED' CHECK(dispatch_status IN('PLANNED','QUEUED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  queued_at timestamptz,
  UNIQUE(session_id,tender_id,company_id,lot_key,portal_id,credential_id)
);

CREATE INDEX IF NOT EXISTS portal_session_context_dispatch_scope_idx
  ON tender.portal_session_context_dispatches(portal_id,company_id,credential_id,created_at DESC);

COMMIT;
