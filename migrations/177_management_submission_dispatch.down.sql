BEGIN;
-- Production rollback keeps this additive schema and every approval/receipt.
-- A schema rollback is permitted only for a never-used isolated installation.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM tender.submission_dispatches) OR EXISTS(SELECT 1 FROM tender.submission_credential_recoveries) OR EXISTS(SELECT 1 FROM tender.submission_adapter_releases) THEN RAISE EXCEPTION 'submission_evidence_present_schema_rollback_forbidden'; END IF;
END $$;
DROP FUNCTION tender.submission_monitor_snapshot();
DROP FUNCTION tender.resume_submission_after_credential_readback(uuid,uuid,uuid);
DROP FUNCTION tender.claim_submission_notification();
DROP FUNCTION tender.finish_submission_notification(uuid,uuid,boolean);
DROP FUNCTION tender.claim_submission_dispatch(text);
DROP FUNCTION tender.record_submission_operation(uuid,uuid,text,jsonb);
DROP TABLE tender.submission_duplicate_attempts;
DROP TABLE tender.submission_credential_recoveries;
DROP TABLE tender.submission_dispatch_operations;
DROP TABLE tender.submission_worker_heartbeats;
DROP TABLE tender.submission_adapter_releases;
DROP TABLE tender.submission_dispatch_notifications;
DROP TABLE tender.submission_dispatch_receipts;
DROP TABLE tender.submission_dispatch_audit;
DROP TABLE tender.submission_dispatches;
DROP FUNCTION tender.guard_submission_receipt();
DROP FUNCTION tender.guard_submission_dispatch();
DROP FUNCTION tender.audit_submission_dispatch();
DROP FUNCTION tender.immutable_submission_evidence();
COMMIT;
