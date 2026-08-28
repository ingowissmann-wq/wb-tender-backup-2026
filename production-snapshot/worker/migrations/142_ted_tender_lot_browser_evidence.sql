BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:ted-tender-lot-browser-evidence:142',0));
LOCK TABLE tender.portal_capability_features IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE matched integer;
BEGIN
  SELECT count(*) INTO matched
  FROM tender.portal_capability_features feature
  JOIN tender.portal_capability_profiles profile ON profile.id=feature.profile_id
  JOIN tender.portal_registry portal ON portal.id=profile.portal_id
  WHERE portal.canonical_domain='ted.europa.eu'
    AND feature.feature_key IN('DISCOVERY','NOTICES')
    AND feature.portal_support='SUPPORTED'
    AND feature.autopilot_supported
    AND feature.actively_configured;
  IF matched<>2 THEN
    RAISE EXCEPTION 'expected exactly two configured TED discovery/notice capability rows, found %',matched;
  END IF;
END $$;

WITH updated AS(
  UPDATE tender.portal_capability_features feature
  SET production_tested=true,browser_acceptance_passed=true,
    evidence_url='https://ted.europa.eu/en/notice/570796-2026/html',
    evidence_note='GET-only official TED HTML matched active tender 570796-2026 and both canonical lots; rendered in isolated Chromium with all browser network requests blocked; evidence sha256 005b4e696c7705d1df4b41825573b28dcaee8374504a78c3282df650d5914d7c',
    verified_at='2026-08-25T20:49:17.831Z'::timestamptz
  FROM tender.portal_capability_profiles profile
  JOIN tender.portal_registry portal ON portal.id=profile.portal_id
  WHERE feature.profile_id=profile.id AND portal.canonical_domain='ted.europa.eu'
    AND feature.feature_key IN('DISCOVERY','NOTICES')
  RETURNING portal.id portal_id,feature.feature_key
)
INSERT INTO tender.audit_events(action,metadata)
SELECT 'ted_public_tender_lot_browser_evidence_verified',jsonb_build_object(
  'portalId',portal_id,'featureKey',feature_key,'requestMethods',jsonb_build_array('GET'),
  'evidenceSha256','005b4e696c7705d1df4b41825573b28dcaee8374504a78c3282df650d5914d7c',
  'externalNetworkRequestsAllowedInBrowser',0,'credentialsUsed',false,
  'externalWrite',false,'transmitted',false
) FROM updated;

INSERT INTO app.schema_migrations(version,description)
VALUES('0142-ted-tender-lot-browser-evidence',
  'Record GET-only official TED tender and canonical lot browser acceptance evidence')
ON CONFLICT(version) DO NOTHING;

COMMIT;
