BEGIN;

ALTER TABLE tender.submission_reconciliation_jobs
  DROP CONSTRAINT IF EXISTS submission_reconciliation_jobs_job_kind_check,
  ADD CONSTRAINT submission_reconciliation_jobs_job_kind_check
    CHECK(job_kind IN('READ_ONLY_STATUS_POLL','RECEIPT_RECONCILIATION','MESSAGE_POLL','AMENDMENT_POLL','DEADLINE_POLL','OUTCOME_POLL'));

CREATE OR REPLACE FUNCTION tender.enforce_portal_inbound_event_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.submission_context_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM tender.submission_contexts context
    WHERE context.id=NEW.submission_context_id AND context.tender_id=NEW.tender_id
      AND context.company_id=NEW.company_id AND context.lot_key=NEW.lot_key
      AND context.portal_id=NEW.portal_id AND context.credential_id IS NOT DISTINCT FROM NEW.credential_id
  ) THEN
    RAISE EXCEPTION 'portal inbound event scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS portal_inbound_event_scope_guard ON tender.portal_inbound_events;
CREATE TRIGGER portal_inbound_event_scope_guard
  BEFORE INSERT
  ON tender.portal_inbound_events FOR EACH ROW EXECUTE FUNCTION tender.enforce_portal_inbound_event_scope();

CREATE OR REPLACE FUNCTION tender.reject_portal_inbound_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='portal inbound event is immutable';
END $$;
DROP TRIGGER IF EXISTS portal_inbound_event_immutable ON tender.portal_inbound_events;
CREATE TRIGGER portal_inbound_event_immutable BEFORE UPDATE OR DELETE ON tender.portal_inbound_events
FOR EACH ROW EXECUTE FUNCTION tender.reject_portal_inbound_event_mutation();

CREATE OR REPLACE VIEW tender.current_submission_feedback AS
SELECT event.tender_id,event.company_id,event.lot_key,event.submission_context_id,
  max(event.observed_at) last_observed_at,
  count(*) FILTER(WHERE event.event_type='MESSAGE')::int message_count,
  count(*) FILTER(WHERE event.event_type='AMENDMENT')::int amendment_count,
  (array_agg(event.event_type ORDER BY event.observed_at DESC,event.received_at DESC))[1] latest_event_type,
  false AS transmitted,
  count(*) FILTER(WHERE event.event_type='RECEIPT')::int receipt_count,
  count(*) FILTER(WHERE event.event_type='STATUS')::int status_count,
  count(*) FILTER(WHERE event.event_type='DEADLINE_CHANGE')::int deadline_change_count,
  count(*) FILTER(WHERE event.event_type='AWARD')::int award_count,
  count(*) FILTER(WHERE event.event_type='REJECTION')::int rejection_count,
  count(*) FILTER(WHERE event.event_type='CANCELLATION')::int cancellation_count
FROM tender.portal_inbound_events event
GROUP BY event.tender_id,event.company_id,event.lot_key,event.submission_context_id;

CREATE INDEX IF NOT EXISTS submission_reconciliation_expired_lease
  ON tender.submission_reconciliation_jobs(lease_expires_at)
  WHERE status='RUNNING';

COMMENT ON INDEX tender.submission_reconciliation_expired_lease IS
  'Recovery index for read-only reconciliation leases; no external or binding action is executed.';

COMMIT;
