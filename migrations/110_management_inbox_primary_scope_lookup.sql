-- Additive scoped lookup for current primary relevance rows. This complements
-- migration 108 for authorized multi-company Management-Inbox filters.
SET lock_timeout='5s';
SET statement_timeout='10min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS service_relevance_company_primary_current_lookup_idx
  ON tender.service_relevance_evaluations
    (company_id, service_line, tender_id, lot_key, evaluation_version DESC, created_at DESC)
  WHERE primary_company=true;

ANALYZE tender.service_relevance_evaluations;
