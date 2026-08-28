BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='10min';

CREATE TABLE IF NOT EXISTS tender.tender_expiry_reviews (
  source_code text NOT NULL CHECK (source_code IN ('TED','DOE')),
  external_id text NOT NULL,
  tender_id uuid REFERENCES tender.tenders(id) ON DELETE SET NULL,
  reason_code text NOT NULL,
  last_known_deadline timestamptz,
  source_updated_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  review_status text NOT NULL DEFAULT 'OPEN' CHECK (review_status IN ('OPEN','RESOLVED')),
  resolved_at timestamptz,
  PRIMARY KEY(source_code,external_id)
);

CREATE INDEX IF NOT EXISTS tender_expiry_reviews_open_idx
  ON tender.tender_expiry_reviews(last_seen_at DESC,reason_code)
  WHERE review_status='OPEN';

COMMIT;
