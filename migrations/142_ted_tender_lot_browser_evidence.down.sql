BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:ted-tender-lot-browser-evidence:142',0));

UPDATE tender.portal_capability_features feature
SET production_tested=false,browser_acceptance_passed=false,
  evidence_url='https://ted.europa.eu/en/about-ted',
  evidence_note='TED veröffentlicht und erschließt Bekanntmachungen; Angebotsabgabe erfolgt über das in der Notice benannte Beschaffungsportal',
  verified_at='2026-08-07T21:38:14.852083Z'::timestamptz
FROM tender.portal_capability_profiles profile
JOIN tender.portal_registry portal ON portal.id=profile.portal_id
WHERE feature.profile_id=profile.id AND portal.canonical_domain='ted.europa.eu'
  AND feature.feature_key IN('DISCOVERY','NOTICES')
  AND feature.evidence_note LIKE 'GET-only official TED HTML matched active tender 570796-2026%';

DELETE FROM app.schema_migrations WHERE version='0142-ted-tender-lot-browser-evidence';

COMMIT;
