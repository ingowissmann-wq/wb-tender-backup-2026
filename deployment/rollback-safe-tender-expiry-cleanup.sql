BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='10min';

-- Application rollback is intentionally non-destructive. Tombstones and cleanup
-- audit evidence are retained so deleted public records cannot reappear.
ALTER TABLE tender.tenders DROP CONSTRAINT IF EXISTS tenders_source_lifecycle_status_chk;
ALTER TABLE tender.tenders ADD CONSTRAINT tenders_source_lifecycle_status_chk
  CHECK(source_lifecycle_status IN ('ACTIVE','EXPIRED','WITHDRAWN','TOMBSTONED'));

COMMIT;
