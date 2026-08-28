-- Isolated-clone fixture only. Values mirror the production registry row.
-- Login and registration remain NULL until a currently reachable official
-- target has been verified; the formerly documented registration target now
-- redirects to the portal's 404 page and must not be offered to users.
INSERT INTO tender.portal_registry(
  id,display_name,canonical_domain,allowed_subdomains,authentication_domains,
  download_domains,login_path,document_path,adapter_id,adapter_version,
  adapter_validation_status,capabilities,login_strategy,document_strategy,
  adapter_enabled,last_verified_at,registration_entry_url,entry_links_verified_at
) VALUES(
  '42fe6df5-5e2f-4549-be4f-48c09dca37d9','MeinAuftrag / RIB','www.meinauftrag.rib.de',
  ARRAY['account.rib.de','evergabe.hannover-stadt.de'],ARRAY['account.rib.de'],
  ARRAY['evergabe.hannover-stadt.de','my.vergabe.rib.de'],'/dashboard/index',
  'https://www.meinauftrag.rib.de/public/publications','rib-meinauftrag','1.1.0',
  'PRODUCTION_VALIDATED',ARRAY['AUTHENTICATED_DOCUMENTS_REQUIRED','CONSENT_REQUIRED','CSRF_REQUIRED','DOCUMENT_LIST_SUPPORTED','DOWNLOAD_HOST_DIFFERENT_DOMAIN','JAVASCRIPT_REQUIRED','LOGIN_BROWSER_REQUIRED','POST_DOWNLOAD_SUPPORTED','SESSION_REFRESH_SUPPORTED','TENDER_SEARCH_SUPPORTED'],
  'BROWSER_DYNAMIC_FORM','RIB_DOCUMENT_AREA',true,'2026-08-10T15:54:01.092Z',
  NULL,NULL
) ON CONFLICT(id) DO UPDATE SET
  display_name=excluded.display_name,canonical_domain=excluded.canonical_domain,
  allowed_subdomains=excluded.allowed_subdomains,authentication_domains=excluded.authentication_domains,
  download_domains=excluded.download_domains,registration_entry_url=excluded.registration_entry_url,
  entry_links_verified_at=excluded.entry_links_verified_at;
