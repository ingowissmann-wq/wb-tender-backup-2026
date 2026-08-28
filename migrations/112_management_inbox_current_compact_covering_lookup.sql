-- Cover the compact current-row projection so the Management-Inbox can apply
-- current/primary selection before fetching wide historical evaluation payloads.
SET lock_timeout='5s';
SET statement_timeout='10min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS service_relevance_company_current_compact_idx
  ON tender.service_relevance_evaluations
    (company_id, service_line, tender_id, lot_key, evaluation_version DESC, created_at DESC)
  INCLUDE (id, relevance_status, primary_company, service_scope_gate);

ANALYZE tender.service_relevance_evaluations;
