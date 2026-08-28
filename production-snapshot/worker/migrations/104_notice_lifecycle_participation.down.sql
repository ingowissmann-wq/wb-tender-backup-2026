BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='10min';

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM tender.notice_lifecycle_correction_runs WHERE status IN('PREPARED','APPLIED')) THEN
    RAISE EXCEPTION 'migration 104 down blocked: correction run not rolled back';
  END IF;
  IF EXISTS(SELECT 1 FROM tender.notice_lifecycle_transitions WHERE correction_run_id IS NOT NULL) THEN
    RAISE EXCEPTION 'migration 104 down blocked: run-bound transitions remain';
  END IF;
END $$;

DROP VIEW IF EXISTS tender.current_participation_eligible_tenders;
DROP VIEW IF EXISTS tender.current_participation_eligible_lots;
DROP INDEX IF EXISTS tender.notice_lifecycle_transitions_run_idx;
DROP INDEX IF EXISTS tender.notice_lifecycle_transitions_tender_idx;
DROP INDEX IF EXISTS tender.notice_lifecycle_correction_rows_tender_idx;
DROP INDEX IF EXISTS tender.tender_notice_relationships_procedure_idx;
DROP INDEX IF EXISTS tender.tender_notice_relationships_related_idx;
DROP INDEX IF EXISTS tender.tender_lot_lifecycles_deadline_evidence_idx;
DROP INDEX IF EXISTS tender.tender_lot_lifecycles_participation_idx;
DROP INDEX IF EXISTS tender.tender_deadline_evidence_tender_idx;
DROP INDEX IF EXISTS tender.tender_deadline_evidence_current_exact_idx;

DROP TABLE tender.notice_lifecycle_transitions;
DROP TABLE tender.notice_lifecycle_correction_rows;
DROP TABLE tender.notice_lifecycle_correction_runs;
DROP TABLE tender.tender_notice_relationships;
DROP TABLE tender.tender_lot_lifecycles;
DROP TABLE tender.tender_deadline_evidence;

ALTER TABLE tender.tenders
  DROP CONSTRAINT IF EXISTS tenders_notice_classification_chk,
  DROP CONSTRAINT IF EXISTS tenders_participation_status_chk,
  DROP CONSTRAINT IF EXISTS tenders_source_lifecycle_status_chk;
ALTER TABLE tender.tenders
  ADD CONSTRAINT tenders_source_lifecycle_status_chk CHECK(source_lifecycle_status IN('ACTIVE','EXPIRED','WITHDRAWN','TOMBSTONED')) NOT VALID;
ALTER TABLE tender.tenders VALIDATE CONSTRAINT tenders_source_lifecycle_status_chk;
ALTER TABLE tender.tenders
  DROP COLUMN IF EXISTS procedure_identifier,
  DROP COLUMN IF EXISTS notice_form_type,
  DROP COLUMN IF EXISTS notice_subtype,
  DROP COLUMN IF EXISTS notice_type_code,
  DROP COLUMN IF EXISTS participation_block_reason,
  DROP COLUMN IF EXISTS participation_status,
  DROP COLUMN IF EXISTS notice_classification;
COMMIT;
