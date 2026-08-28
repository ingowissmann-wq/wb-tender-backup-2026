DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM app.schema_migrations WHERE version='0128-portal-family-host-profiles') THEN
    RAISE EXCEPTION 'migration marker remains after rollback';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='tender'
      AND indexname='portal_registry_adapter_host_entrypoint_unique') THEN
    RAISE EXCEPTION 'safe per-host uniqueness was removed';
  END IF;
  IF (SELECT count(*) FROM tender.portal_registry WHERE adapter_id='ai-vergabe-manager'
      AND canonical_domain IN('vergabe.landbw.de','vergabe.stadt-frankfurt.de',
        'www.ausschreibungen.ls.brandenburg.de','www.deutsches-ausschreibungsblatt.de'))<>4 THEN
    RAISE EXCEPTION 'classified profiles were destructively rolled back';
  END IF;
END $$;
