DO $$
DECLARE classified integer; enabled integer; ai_roots integer; bad_urls integer;
BEGIN
  SELECT count(*) INTO classified FROM tender.portal_registry
  WHERE canonical_domain=ANY(ARRAY[
    'plattform.aumass.de','vergabe.landbw.de','vergabe.stadt-frankfurt.de',
    'www.ausschreibungen.ls.brandenburg.de','www.deutsches-ausschreibungsblatt.de',
    'www.evergabe.nrw.de','www.vergabe.metropoleruhr.de'
  ]::text[]) AND adapter_id IN('ai-vergabe-manager','cosinex','aumass');
  IF classified<>7 THEN RAISE EXCEPTION 'expected 7 classified hosts, got %',classified; END IF;

  SELECT count(*) INTO enabled FROM tender.portal_registry
  WHERE canonical_domain=ANY(ARRAY[
    'plattform.aumass.de','vergabe.landbw.de','vergabe.stadt-frankfurt.de',
    'www.ausschreibungen.ls.brandenburg.de','www.deutsches-ausschreibungsblatt.de',
    'www.evergabe.nrw.de','www.vergabe.metropoleruhr.de'
  ]::text[]) AND adapter_enabled;
  IF enabled<>0 THEN RAISE EXCEPTION 'migration enabled % adapters',enabled; END IF;

  SELECT count(*) INTO ai_roots FROM tender.portal_registry
  WHERE adapter_id='ai-vergabe-manager' AND entrypoint_type='ROOT'
    AND canonical_domain IN('vergabe.landbw.de','vergabe.stadt-frankfurt.de',
      'www.ausschreibungen.ls.brandenburg.de','www.deutsches-ausschreibungsblatt.de');
  IF ai_roots<>4 THEN RAISE EXCEPTION 'multi-host AI family rejected, got %',ai_roots; END IF;

  SELECT count(*) INTO bad_urls FROM tender.portal_registry
  WHERE canonical_domain=ANY(ARRAY[
    'plattform.aumass.de','vergabe.landbw.de','vergabe.stadt-frankfurt.de',
    'www.ausschreibungen.ls.brandenburg.de','www.deutsches-ausschreibungsblatt.de',
    'www.evergabe.nrw.de','www.vergabe.metropoleruhr.de'
  ]::text[]) AND (bidder_area_url IS NULL OR authentication_entry_url IS NULL OR registration_entry_url IS NULL);
  IF bad_urls<>0 THEN RAISE EXCEPTION 'missing official entry URLs for % hosts',bad_urls; END IF;

  IF (SELECT count(*) FROM tender.portal_registry WHERE adapter_validation_status='VALIDATED_READ_ONLY'
      AND canonical_domain IN('vergabe.landbw.de','vergabe.stadt-frankfurt.de',
        'www.ausschreibungen.ls.brandenburg.de','www.evergabe.nrw.de',
        'www.vergabe.metropoleruhr.de','plattform.aumass.de','www.deutsches-ausschreibungsblatt.de'))<>7 THEN
    RAISE EXCEPTION 'expected seven host-specific read validations';
  END IF;
  IF to_regclass('tender.current_portal_host_capability_truth') IS NULL THEN
    RAISE EXCEPTION 'host-specific capability view missing';
  END IF;
  IF (SELECT count(*) FROM tender.current_portal_host_capability_truth capability
      JOIN tender.portal_registry portal ON portal.id=capability.portal_id
      WHERE capability.feature_key='DOCUMENT_DOWNLOAD' AND capability.production_tested
        AND portal.canonical_domain=ANY(ARRAY[
          'plattform.aumass.de','vergabe.landbw.de','vergabe.stadt-frankfurt.de',
          'www.ausschreibungen.ls.brandenburg.de','www.deutsches-ausschreibungsblatt.de',
          'www.evergabe.nrw.de','www.vergabe.metropoleruhr.de'
        ]::text[]))<>7 THEN
    RAISE EXCEPTION 'expected seven tested host document capabilities';
  END IF;
  IF (SELECT count(*) FROM tender.current_portal_host_capability_truth capability
      JOIN tender.portal_registry portal ON portal.id=capability.portal_id
      WHERE capability.feature_key='LOGIN' AND capability.autopilot_supported
        AND capability.actively_configured AND NOT capability.production_tested
        AND NOT capability.browser_acceptance_passed
        AND portal.canonical_domain=ANY(ARRAY[
          'plattform.aumass.de','vergabe.landbw.de','vergabe.stadt-frankfurt.de',
          'www.ausschreibungen.ls.brandenburg.de','www.deutsches-ausschreibungsblatt.de',
          'www.evergabe.nrw.de','www.vergabe.metropoleruhr.de'
        ]::text[]))<>7 THEN
    RAISE EXCEPTION 'expected seven implemented but not authenticated login capabilities';
  END IF;

  IF EXISTS(SELECT 1 FROM tender.submission_contexts WHERE transmitted=true) THEN
    RAISE EXCEPTION 'submission transmission changed';
  END IF;
END $$;
