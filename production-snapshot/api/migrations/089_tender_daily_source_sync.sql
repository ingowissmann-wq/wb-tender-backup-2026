BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='10min';

ALTER TABLE tender.tenders
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_lifecycle_status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS source_withdrawn_at timestamptz,
  ADD COLUMN IF NOT EXISTS classification_status text NOT NULL DEFAULT 'CLASSIFIED';

UPDATE tender.tenders
SET last_synced_at = coalesce(last_synced_at, updated_at, created_at),
    source_lifecycle_status = CASE
      WHEN source_withdrawn_at IS NOT NULL THEN 'WITHDRAWN'
      WHEN offer_deadline IS NOT NULL AND offer_deadline < now() THEN 'EXPIRED'
      ELSE 'ACTIVE'
    END
WHERE last_synced_at IS NULL
   OR source_lifecycle_status IS DISTINCT FROM CASE
      WHEN source_withdrawn_at IS NOT NULL THEN 'WITHDRAWN'
      WHEN offer_deadline IS NOT NULL AND offer_deadline < now() THEN 'EXPIRED'
      ELSE 'ACTIVE'
    END;

UPDATE tender.tenders tender
SET classification_status = CASE
  WHEN EXISTS(SELECT 1 FROM tender.service_relevance_evaluations evaluation WHERE evaluation.tender_id=tender.id AND evaluation.primary_company=true AND evaluation.relevance_status='RELEVANT') THEN 'CLASSIFIED'
  WHEN EXISTS(SELECT 1 FROM tender.service_relevance_evaluations evaluation WHERE evaluation.tender_id=tender.id AND evaluation.relevance_status='MANUAL_CLASSIFICATION_REQUIRED') THEN 'REVIEW_REQUIRED'
  ELSE 'CLASSIFIED'
END
WHERE tender.data_class='PUBLIC_REAL';

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tenders_source_lifecycle_status_chk') THEN
    ALTER TABLE tender.tenders ADD CONSTRAINT tenders_source_lifecycle_status_chk
      CHECK(source_lifecycle_status IN ('ACTIVE','EXPIRED','WITHDRAWN'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tenders_classification_status_chk') THEN
    ALTER TABLE tender.tenders ADD CONSTRAINT tenders_classification_status_chk
      CHECK(classification_status IN ('PENDING','CLASSIFIED','REVIEW_REQUIRED'));
  END IF;
END $constraints$;

CREATE INDEX IF NOT EXISTS tenders_current_overview_idx
  ON tender.tenders(data_class,source_lifecycle_status,publication_date DESC,updated_at DESC,id);
CREATE INDEX IF NOT EXISTS tenders_classification_status_idx
  ON tender.tenders(classification_status) WHERE classification_status <> 'CLASSIFIED';

UPDATE tender.scheduler_sources
SET interval_minutes=1440,
    next_run_at=NULL,
    updated_at=now()
WHERE source_code IN ('TED','DOE') AND mode='PRODUCTION_READ';

COMMIT;
