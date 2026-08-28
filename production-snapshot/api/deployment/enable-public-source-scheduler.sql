BEGIN;

DO $block$
BEGIN
  IF (SELECT count(*) FROM tender.scheduler_sources WHERE source_code IN ('TED','DOE') AND mode='PRODUCTION_READ') <> 2 THEN
    RAISE EXCEPTION 'public production-read scheduler sources are incomplete';
  END IF;
END
$block$;

UPDATE tender.scheduler_sources
SET enabled=true,kill_switch=false,updated_at=now()
WHERE source_code IN ('TED','DOE') AND mode='PRODUCTION_READ';

COMMIT;
