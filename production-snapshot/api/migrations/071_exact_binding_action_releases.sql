BEGIN;

ALTER TABLE tender.portal_inbound_events
  DROP CONSTRAINT IF EXISTS portal_inbound_events_event_type_check,
  ADD CONSTRAINT portal_inbound_events_event_type_check
    CHECK(event_type IN('RECEIPT','STATUS','MESSAGE','AMENDMENT','DEADLINE_CHANGE','AWARD','REJECTION','CANCELLATION'));

CREATE TABLE IF NOT EXISTS tender.binding_action_releases(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_context_id uuid NOT NULL REFERENCES tender.submission_contexts(id),
  company_id uuid NOT NULL REFERENCES tender.enterprise_company_links(company_id),
  credential_id uuid NOT NULL REFERENCES tender.portal_credential_secrets(id),
  portal_id uuid NOT NULL REFERENCES tender.portal_registry(id),
  tender_id uuid NOT NULL REFERENCES tender.tenders(id),
  lot_key text NOT NULL DEFAULT '',
  bid_package_hash text NOT NULL CHECK(bid_package_hash~'^[0-9a-f]{64}$'),
  management_approval_request_id uuid NOT NULL REFERENCES tender.approval_requests(id),
  binding_sha256 text NOT NULL CHECK(binding_sha256~'^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL UNIQUE CHECK(idempotency_key~'^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'REQUESTED' CHECK(status IN('REQUESTED','APPROVED','REVOKED','EXPIRED','INVALIDATED')),
  requested_by uuid NOT NULL REFERENCES iam.users(id),
  approved_by uuid REFERENCES iam.users(id),
  revoked_by uuid REFERENCES iam.users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz NOT NULL,
  transmitted boolean NOT NULL DEFAULT false CHECK(transmitted=false),
  CHECK(expires_at>requested_at),
  CHECK(approved_by IS NULL OR approved_by<>requested_by),
  CHECK(status<>'APPROVED' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK(status<>'REVOKED' OR (revoked_by IS NOT NULL AND revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS binding_action_release_active_scope
  ON tender.binding_action_releases(company_id,credential_id,portal_id,tender_id,lot_key,bid_package_hash)
  WHERE status IN('REQUESTED','APPROVED');
CREATE INDEX IF NOT EXISTS binding_action_release_context_history
  ON tender.binding_action_releases(submission_context_id,requested_at DESC);

CREATE TABLE IF NOT EXISTS tender.binding_action_release_events(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL REFERENCES tender.binding_action_releases(id),
  event_type text NOT NULL CHECK(event_type IN('REQUESTED','APPROVED','REVOKED','EXPIRED','INVALIDATED')),
  actor_id uuid REFERENCES iam.users(id),
  binding_sha256 text NOT NULL CHECK(binding_sha256~'^[0-9a-f]{64}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  external_write boolean NOT NULL DEFAULT false CHECK(external_write=false),
  transmitted boolean NOT NULL DEFAULT false CHECK(transmitted=false)
);

CREATE OR REPLACE FUNCTION tender.reject_binding_release_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='binding action release event is immutable';
END $$;
DROP TRIGGER IF EXISTS binding_action_release_event_immutable ON tender.binding_action_release_events;
CREATE TRIGGER binding_action_release_event_immutable BEFORE UPDATE OR DELETE ON tender.binding_action_release_events
FOR EACH ROW EXECUTE FUNCTION tender.reject_binding_release_event_mutation();

CREATE OR REPLACE FUNCTION tender.enforce_binding_action_release_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM tender.submission_contexts context
    JOIN tender.submission_package_manifests manifest ON manifest.submission_context_id=context.id
    JOIN tender.portal_credential_secrets credential ON credential.id=NEW.credential_id AND credential.portal_id=context.portal_id AND credential.status='ACTIVE'
    JOIN tender.portal_credential_companies company_scope ON company_scope.credential_id=credential.id AND company_scope.company_id=context.company_id AND company_scope.active=true
    JOIN tender.approval_requests approval ON approval.id=context.approval_request_id AND approval.status='APPROVED'
      AND (approval.expires_at IS NULL OR approval.expires_at>now())
    WHERE context.id=NEW.submission_context_id AND context.tender_id=NEW.tender_id
      AND context.company_id=NEW.company_id AND context.portal_id=NEW.portal_id AND context.lot_key=NEW.lot_key
      AND context.approval_request_id=NEW.management_approval_request_id
      AND manifest.manifest_sha256=NEW.bid_package_hash AND manifest.transmitted=false
  ) THEN
    RAISE EXCEPTION 'binding action release scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS binding_action_release_scope_guard ON tender.binding_action_releases;
CREATE TRIGGER binding_action_release_scope_guard
  BEFORE INSERT OR UPDATE OF submission_context_id,company_id,credential_id,portal_id,tender_id,lot_key,bid_package_hash,management_approval_request_id
  ON tender.binding_action_releases FOR EACH ROW EXECUTE FUNCTION tender.enforce_binding_action_release_scope();

COMMENT ON TABLE tender.binding_action_releases IS
  'Short-lived exact-scope four-eyes release for internal finalization only. It never enables binding portal execution; all external endpoints remain HTTP 423.';

COMMIT;
