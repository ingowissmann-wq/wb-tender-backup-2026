BEGIN;
INSERT INTO tender.portal_registry(display_name,canonical_domain,adapter_validation_status,adapter_enabled)
SELECT display_name,canonical_domain,'NEEDS_ADAPTER_IMPLEMENTATION',false FROM (VALUES
  ('AUMASS fixture','plattform.aumass.de'),
  ('LandBW fixture','vergabe.landbw.de'),
  ('Frankfurt fixture','vergabe.stadt-frankfurt.de'),
  ('LS Brandenburg fixture','www.ausschreibungen.ls.brandenburg.de'),
  ('Ausschreibungsblatt fixture','www.deutsches-ausschreibungsblatt.de'),
  ('NRW fixture','www.evergabe.nrw.de'),
  ('Metropole Ruhr fixture','www.vergabe.metropoleruhr.de')
) fixture(display_name,canonical_domain)
ON CONFLICT(canonical_domain) DO NOTHING;
COMMIT;
