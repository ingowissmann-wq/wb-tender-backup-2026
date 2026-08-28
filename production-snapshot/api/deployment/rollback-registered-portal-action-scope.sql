BEGIN;

DROP VIEW IF EXISTS tender.current_registered_tender_company_portals;
DROP VIEW IF EXISTS tender.current_tender_portal_mapping_truth;

DROP INDEX IF EXISTS tender.enrichment_documents_explicit_portal_idx;
DROP INDEX IF EXISTS tender.enrichment_versions_current_tender_version_idx;
DROP INDEX IF EXISTS tender.portal_credential_scope_active_company_idx;

-- Data, document provenance, audit history, credentials, sessions and all
-- submission locks remain untouched.  The RC21 runtime does not depend on
-- these views and is therefore the application rollback target.
COMMIT;
