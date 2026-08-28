BEGIN;

UPDATE tender.scheduler_sources
SET enabled=false,kill_switch=true,updated_at=now()
WHERE source_code IN ('TED','DOE');

DELETE FROM tender.scheduler_leases WHERE source_code IN ('TED','DOE');

COMMIT;
