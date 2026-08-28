BEGIN;

UPDATE tender.scheduler_sources
SET interval_minutes=360,
    next_run_at=now()+interval '6 hours',
    updated_at=now()
WHERE source_code IN ('TED','DOE') AND mode='PRODUCTION_READ';

-- The migration is additive. Keep synchronized tender data and its derived
-- lifecycle/classification evidence during an application rollback. The prior
-- image ignores these columns and indexes safely. A physical schema rollback
-- is only performed by restoring the verified pre-change database backup.

COMMIT;
