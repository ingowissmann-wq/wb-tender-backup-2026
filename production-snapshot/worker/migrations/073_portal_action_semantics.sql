BEGIN;

ALTER TABLE tender.portal_registry
  ADD COLUMN IF NOT EXISTS authentication_entry_url text,
  ADD COLUMN IF NOT EXISTS bidder_area_url text;

COMMENT ON COLUMN tender.portal_registry.authentication_entry_url IS
  'Maintained authoritative authentication entry. Never inferred from a document URL or request input.';
COMMENT ON COLUMN tender.portal_registry.bidder_area_url IS
  'Maintained authoritative read-only bidder-area entry on an allowlisted exact host.';

ALTER TABLE tender.portal_registry
  DROP CONSTRAINT IF EXISTS portal_registry_authentication_entry_https,
  ADD CONSTRAINT portal_registry_authentication_entry_https
    CHECK(authentication_entry_url IS NULL OR authentication_entry_url ~ '^https://[^/?#]+/'),
  DROP CONSTRAINT IF EXISTS portal_registry_bidder_area_https,
  ADD CONSTRAINT portal_registry_bidder_area_https
    CHECK(bidder_area_url IS NULL OR bidder_area_url ~ '^https://[^/?#]+/');

UPDATE tender.portal_registry
SET authentication_entry_url='https://vergabemarktplatz.brandenburg.de/VMPCenter/company/login.do?service=https%3A%2F%2Fvergabemarktplatz.brandenburg.de%2FVMPCenter%2Fsecured%2Fcompany%2Fwelcome.do',
    bidder_area_url='https://vergabemarktplatz.brandenburg.de/VMPCenter/secured/company/welcome.do',
    authentication_domains=array(SELECT DISTINCT host FROM unnest(coalesce(authentication_domains,ARRAY[]::text[])||ARRAY['vergabemarktplatz.brandenburg.de']) host),
    updated_at=now()
WHERE adapter_id='cosinex-vmp-public'
  AND canonical_domain='vergabemarktplatz.brandenburg.de';

COMMIT;
