-- Phase 1 Regionsinbox: support the exact active evaluation identity used by
-- counters, filters, cards, details and pagination. Additive and data-neutral.
SET lock_timeout='5s';
SET statement_timeout='10min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS region_evaluations_management_inbox_exact_idx
 ON tender.region_evaluations(
   tenant_id,
   company_id,
   canonical_service,
   profile_id,
   region_profile_version_id,
   configuration_version_id,
   tender_id,
   lot_id,
   evaluation_version DESC,
   created_at DESC,
   id DESC
 );
