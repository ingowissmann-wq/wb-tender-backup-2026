\set ON_ERROR_STOP on
BEGIN;

WITH changed AS (
  UPDATE tender.portal_registry
     SET registration_entry_url = NULL,
         entry_links_verified_at = CASE WHEN authentication_entry_url IS NULL THEN NULL ELSE entry_links_verified_at END,
         entry_links_verified_by = CASE WHEN authentication_entry_url IS NULL THEN NULL ELSE entry_links_verified_by END,
         updated_at = now()
   WHERE id = '42fe6df5-5e2f-4549-be4f-48c09dca37d9'
     AND canonical_domain = 'www.meinauftrag.rib.de'
     AND registration_entry_url = 'https://www.meinauftrag.rib.de/public/register-Company'
  RETURNING id, canonical_domain
)
INSERT INTO tender.audit_events(actor_id, action, metadata)
SELECT NULL, 'portal_registry_entry_link_removed_unreachable',
       jsonb_build_object(
         'portalId', id,
         'canonicalHost', canonical_domain,
         'linkType', 'REGISTRATION',
         'reason', 'OFFICIAL_DOCUMENTED_TARGET_REDIRECTED_TO_PORTAL_404',
         'credentialOrSecretProcessed', false
       )
FROM changed;

COMMIT;
