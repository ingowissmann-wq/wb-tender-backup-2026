-- Additive lookup index for fast current-row selection across the authorized
-- company/service scopes used by the Management-Inbox "all" filter.
-- No rows or business bindings are rewritten.
SET lock_timeout='5s';
SET statement_timeout='10min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS service_relevance_company_current_lookup_idx
  ON tender.service_relevance_evaluations
    (company_id, service_line, tender_id, lot_key, evaluation_version DESC, created_at DESC);

ANALYZE tender.service_relevance_evaluations;
