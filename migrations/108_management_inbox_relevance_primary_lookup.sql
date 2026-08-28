-- Current-release Management-Inbox 504 repair.
-- Additive, idempotent lookup index only; no data rewrite or timeout change.
SET lock_timeout='5s';
SET statement_timeout='10min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS service_relevance_primary_current_idx
  ON tender.service_relevance_evaluations
    (tender_id, company_id, lot_key, evaluation_version DESC)
  WHERE primary_company=true;

ANALYZE tender.service_relevance_evaluations;
