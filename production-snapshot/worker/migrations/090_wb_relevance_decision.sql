BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='10min';

ALTER TABLE tender.tenders
  ADD COLUMN IF NOT EXISTS wb_relevance_status text NOT NULL DEFAULT 'REVIEW_REQUIRED',
  ADD COLUMN IF NOT EXISTS assigned_service_line text,
  ADD COLUMN IF NOT EXISTS classification_confidence text NOT NULL DEFAULT 'REVIEW',
  ADD COLUMN IF NOT EXISTS classification_basis text,
  ADD COLUMN IF NOT EXISTS classification_rule_id text,
  ADD COLUMN IF NOT EXISTS classification_reason text,
  ADD COLUMN IF NOT EXISTS classified_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tenders_wb_relevance_status_chk') THEN
    ALTER TABLE tender.tenders ADD CONSTRAINT tenders_wb_relevance_status_chk
      CHECK(wb_relevance_status IN ('RELEVANT','NOT_RELEVANT','REVIEW_REQUIRED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tenders_classification_confidence_chk') THEN
    ALTER TABLE tender.tenders ADD CONSTRAINT tenders_classification_confidence_chk
      CHECK(classification_confidence IN ('HIGH','REVIEW'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS tenders_wb_customer_overview_idx
  ON tender.tenders(publication_date DESC,updated_at DESC,id)
  WHERE data_class='PUBLIC_REAL'
    AND source_lifecycle_status='ACTIVE'
    AND wb_relevance_status='RELEVANT'
    AND classification_confidence='HIGH';

COMMIT;
