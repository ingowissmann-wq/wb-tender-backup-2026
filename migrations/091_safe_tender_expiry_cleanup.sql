BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='10min';

CREATE TABLE IF NOT EXISTS tender.tender_tombstones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_code text NOT NULL CHECK (source_code IN ('TED','DOE')),
  external_id text NOT NULL,
  last_known_deadline timestamptz NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  deletion_reason text NOT NULL,
  last_source_status text,
  source_updated_at timestamptz NOT NULL,
  tombstone_status text NOT NULL DEFAULT 'DELETED'
    CHECK (tombstone_status IN ('DELETED','REACTIVATED')),
  reactivated_at timestamptz,
  reactivation_reason text,
  reactivation_source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_code,external_id)
);

CREATE INDEX IF NOT EXISTS tender_tombstones_deleted_idx
  ON tender.tender_tombstones(tombstone_status,deleted_at DESC);

CREATE TABLE IF NOT EXISTS tender.tender_cleanup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_kind text NOT NULL CHECK (run_kind IN ('SCHEDULED','MANUAL')),
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCESS','FAILED','SKIPPED_SYNC_FAILURE')),
  sync_run_ids uuid[] NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  checked_count integer NOT NULL DEFAULT 0,
  deleted_count integer NOT NULL DEFAULT 0,
  tombstone_count integer NOT NULL DEFAULT 0,
  protected_count integer NOT NULL DEFAULT 0,
  ambiguous_count integer NOT NULL DEFAULT 0,
  deleted_file_count integer NOT NULL DEFAULT 0,
  deleted_file_bytes bigint NOT NULL DEFAULT 0,
  deleted_source_bytes bigint NOT NULL DEFAULT 0,
  database_bytes_before bigint,
  database_bytes_after bigint,
  filesystem_free_bytes_before bigint,
  filesystem_free_bytes_after bigint,
  wal_bytes bigint NOT NULL DEFAULT 0,
  duration_ms bigint,
  error_count integer NOT NULL DEFAULT 0,
  error_code text,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tender_cleanup_runs_latest_idx
  ON tender.tender_cleanup_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS tender.tender_cleanup_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_run_id uuid NOT NULL REFERENCES tender.tender_cleanup_runs(id),
  source_code text NOT NULL CHECK (source_code IN ('TED','DOE')),
  external_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('DELETED','PROTECTED_TOMBSTONE','SKIPPED_AMBIGUOUS','ERROR')),
  reason_code text NOT NULL,
  attachment_count integer NOT NULL DEFAULT 0,
  attachment_bytes bigint NOT NULL DEFAULT 0,
  source_bytes bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(cleanup_run_id,source_code,external_id)
);

CREATE INDEX IF NOT EXISTS tender_cleanup_items_source_idx
  ON tender.tender_cleanup_items(source_code,external_id,created_at DESC);

ALTER TABLE tender.import_runs
  ADD COLUMN IF NOT EXISTS tombstone_skipped_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reactivated_count integer NOT NULL DEFAULT 0;

ALTER TABLE tender.scheduler_runs
  ADD COLUMN IF NOT EXISTS tombstone_skipped_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reactivated_count integer NOT NULL DEFAULT 0;

ALTER TABLE tender.tenders DROP CONSTRAINT IF EXISTS tenders_source_lifecycle_status_chk;
ALTER TABLE tender.tenders ADD CONSTRAINT tenders_source_lifecycle_status_chk
  CHECK(source_lifecycle_status IN ('ACTIVE','EXPIRED','WITHDRAWN','TOMBSTONED'));

COMMIT;
