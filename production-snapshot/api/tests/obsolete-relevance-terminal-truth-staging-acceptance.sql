DO $$
DECLARE affected int;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM app.schema_migrations WHERE version='0140-obsolete-relevance-terminal-truth') THEN
    RAISE EXCEPTION 'migration 0140 marker missing';
  END IF;
  SELECT count(*) INTO affected FROM tender.autopilot_queue
  WHERE result_summary->>'terminalClassificationVersion'='obsolete-relevance-terminal-v1';
  IF affected<>16 THEN RAISE EXCEPTION 'expected 16 reclassified legacy rows, got %',affected; END IF;
  IF EXISTS(SELECT 1 FROM tender.autopilot_queue
    WHERE coalesce(safe_error_code,error_code)='NOT_ELIGIBLE' AND status='DEAD_LETTER') THEN
    RAISE EXCEPTION 'legacy NOT_ELIGIBLE dead letter remains';
  END IF;
  IF EXISTS(SELECT 1 FROM tender.autopilot_queue
    WHERE result_summary->>'terminalClassificationVersion'='obsolete-relevance-terminal-v1'
      AND (status<>'SUCCEEDED' OR current_step<>'SUPERSEDED_BY_CURRENT_RELEVANCE')) THEN
    RAISE EXCEPTION 'reclassified row has wrong terminal state';
  END IF;
END $$;
