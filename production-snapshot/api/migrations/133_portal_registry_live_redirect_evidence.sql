BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';

SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:portal-registry-live-redirect-evidence:133',0));
LOCK TABLE tender.portal_registry IN SHARE ROW EXCLUSIVE MODE;

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
), updated AS(
  UPDATE tender.portal_registry registry
  SET allowed_subdomains=ARRAY(
    SELECT DISTINCT host FROM unnest(coalesce(registry.allowed_subdomains,'{}'::text[])||ARRAY[evidence.target_host]) host
    ORDER BY host
  ),updated_at=now()
  FROM evidence WHERE registry.canonical_domain=evidence.canonical_domain
    AND NOT(evidence.target_host=ANY(coalesce(registry.allowed_subdomains,'{}'::text[])))
  RETURNING registry.id,registry.canonical_domain,evidence.target_host
)
INSERT INTO tender.audit_events(action,metadata)
SELECT 'portal_registry_redirect_host_verified',jsonb_build_object(
  'portalId',id,'canonicalDomain',canonical_domain,'targetHost',target_host,
  'registryField','allowed_subdomains','evidence','GET_ONLY_2026-08-25',
  'evidenceSha256','9901328ffc1b57b532fcbf200a7eea0801791054b90809c02f8e777b7d866e5c',
  'externalWrite',false
) FROM updated;

WITH evidence(canonical_domain,target_host) AS(VALUES
  ('ted.europa.eu','ecas.ec.europa.eu'),
  ('www.vergabe.metropoleruhr.de','www.evergabe.nrw.de')
), updated AS(
  UPDATE tender.portal_registry registry
  SET authentication_domains=ARRAY(
    SELECT DISTINCT host FROM unnest(coalesce(registry.authentication_domains,'{}'::text[])||ARRAY[evidence.target_host]) host
    ORDER BY host
  ),updated_at=now()
  FROM evidence WHERE registry.canonical_domain=evidence.canonical_domain
    AND NOT(evidence.target_host=ANY(coalesce(registry.authentication_domains,'{}'::text[])))
  RETURNING registry.id,registry.canonical_domain,evidence.target_host
)
INSERT INTO tender.audit_events(action,metadata)
SELECT 'portal_registry_redirect_host_verified',jsonb_build_object(
  'portalId',id,'canonicalDomain',canonical_domain,'targetHost',target_host,
  'registryField','authentication_domains','evidence','GET_ONLY_2026-08-25',
  'evidenceSha256','9901328ffc1b57b532fcbf200a7eea0801791054b90809c02f8e777b7d866e5c',
  'externalWrite',false
) FROM updated;

WITH updated AS(
  UPDATE tender.portal_registry
  SET bidder_area_url='https://www.evergabe.de/bieter',updated_at=now()
  WHERE canonical_domain='www.evergabe.de'
    AND bidder_area_url='https://www.evergabe.de/ausschreibungen'
  RETURNING id,canonical_domain
)
INSERT INTO tender.audit_events(action,metadata)
SELECT 'portal_registry_bidder_area_repaired',jsonb_build_object(
  'portalId',id,'canonicalDomain',canonical_domain,
  'oldUrl','https://www.evergabe.de/ausschreibungen',
  'newUrl','https://www.evergabe.de/bieter','verifiedHttpStatus',200,
  'evidence','OFFICIAL_PORTAL_GET_2026-08-25','externalWrite',false
) FROM updated;

INSERT INTO app.schema_migrations(version,description)
VALUES('0133-portal-registry-live-redirect-evidence',
  'Add only GET-observed exact HTTPS redirect hosts and repair the verified evergabe.de bidder entry URL')
ON CONFLICT(version) DO NOTHING;

COMMIT;
