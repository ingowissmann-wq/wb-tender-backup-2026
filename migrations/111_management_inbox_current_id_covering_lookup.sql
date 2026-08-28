-- Index-only discovery of the latest row id per authorized company/service
-- context. Wide evaluation payloads are fetched only for current rows.
SET lock_timeout='5s';
SET statement_timeout='10min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS service_relevance_company_current_id_lookup_idx
  ON tender.service_relevance_evaluations
    (company_id, service_line, tender_id, lot_key, evaluation_version DESC, created_at DESC)
  INCLUDE (id);

ANALYZE tender.service_relevance_evaluations;
