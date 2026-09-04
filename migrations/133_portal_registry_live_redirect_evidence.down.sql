BEGIN;

WITH evidence(canonical_domain,target_host) AS(VALUES
  ('bieterzugang.deutsche-evergabe.de','www.deutsche-evergabe.de'),
  ('ec.europa.eu','commission.europa.eu'),
  ('lwl.org','www2.lwl.org'),
  ('saarvpsl.vmstart.de','vergabe.saarland'),
  ('vergabe.stadt-frankfurt.de','www.vergabe.stadt-frankfurt.de'),
  ('www.deutsche-rentenversicherung-bund.de','www.deutsche-rentenversicherung.de'),
  ('www.evergabe.bayern.de','www.vergabe.bayern.de'),
  ('www.tender24.de','tender24.de'),
  ('www.vergabemarktplatz-mv.de','vergabemarktplatz-mv.de')
)
UPDATE tender.portal_registry registry
SET allowed_subdomains=array_remove(registry.allowed_subdomains,evidence.target_host),updated_at=now()
FROM evidence WHERE registry.canonical_domain=evidence.canonical_domain;

WITH evidence(canonical_domain,target_host) AS(VALUES
  ('ted.europa.eu','ecas.ec.europa.eu'),
  ('www.vergabe.metropoleruhr.de','www.evergabe.nrw.de')
)
UPDATE tender.portal_registry registry
SET authentication_domains=array_remove(registry.authentication_domains,evidence.target_host),updated_at=now()
FROM evidence WHERE registry.canonical_domain=evidence.canonical_domain;

UPDATE tender.portal_registry
SET bidder_area_url='https://www.evergabe.de/ausschreibungen',updated_at=now()
WHERE canonical_domain='www.evergabe.de'
  AND bidder_area_url='https://www.evergabe.de/bieter';

DELETE FROM app.schema_migrations
WHERE version='0133-portal-registry-live-redirect-evidence';

COMMIT;
