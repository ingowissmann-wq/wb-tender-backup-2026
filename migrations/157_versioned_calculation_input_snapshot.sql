BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:migration:157-versioned-calculation-input-snapshot',0));

ALTER TABLE tender.calculation_input_snapshots
  ADD COLUMN IF NOT EXISTS contract_version text,
  ADD COLUMN IF NOT EXISTS contract_state text,
  ADD COLUMN IF NOT EXISTS engine_input jsonb,
  ADD COLUMN IF NOT EXISTS fact_records jsonb,
  ADD COLUMN IF NOT EXISTS parameter_records jsonb,
  ADD COLUMN IF NOT EXISTS document_fingerprints jsonb,
  ADD COLUMN IF NOT EXISTS rule_types jsonb;

ALTER TABLE tender.calculations
  ADD COLUMN IF NOT EXISTS calculation_input_snapshot_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='tender.calculation_input_snapshots'::regclass
      AND conname='calculation_input_snapshots_v4_contract_check'
  ) THEN
    ALTER TABLE tender.calculation_input_snapshots
      ADD CONSTRAINT calculation_input_snapshots_v4_contract_check CHECK (
        schema_version<4 OR (
          schema_version=4
          AND contract_version='wb-tender-calculation-contract/1.0.0'
          AND contract_state IN ('READY','SHADOW','NEW_TENDER_TYPE_CANDIDATE','QUARANTINED')
          AND jsonb_typeof(engine_input)='object'
          AND jsonb_typeof(fact_records)='array'
          AND jsonb_typeof(parameter_records)='array'
          AND jsonb_typeof(document_fingerprints)='array'
          AND jsonb_typeof(rule_types)='array'
          AND snapshot_sha256::text ~ '^[a-f0-9]{64}$'
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='tender.calculations'::regclass
      AND conname='calculations_input_snapshot_fkey'
  ) THEN
    ALTER TABLE tender.calculations
      ADD CONSTRAINT calculations_input_snapshot_fkey
      FOREIGN KEY(calculation_input_snapshot_id)
      REFERENCES tender.calculation_input_snapshots(id)
      NOT VALID;
  END IF;
END $$;

ALTER TABLE tender.calculation_input_snapshots
  VALIDATE CONSTRAINT calculation_input_snapshots_v4_contract_check;
ALTER TABLE tender.calculations
  VALIDATE CONSTRAINT calculations_input_snapshot_fkey;

CREATE INDEX IF NOT EXISTS calculations_input_snapshot_idx
  ON tender.calculations(calculation_input_snapshot_id)
  WHERE calculation_input_snapshot_id IS NOT NULL;

CREATE OR REPLACE FUNCTION tender.guard_immutable_calculation_input_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.schema_version>=4 AND (
    NEW.schema_version IS DISTINCT FROM OLD.schema_version
    OR NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256
    OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
    OR NEW.contract_state IS DISTINCT FROM OLD.contract_state
    OR NEW.engine_input IS DISTINCT FROM OLD.engine_input
    OR NEW.fact_records IS DISTINCT FROM OLD.fact_records
    OR NEW.parameter_records IS DISTINCT FROM OLD.parameter_records
    OR NEW.document_fingerprints IS DISTINCT FROM OLD.document_fingerprints
    OR NEW.rule_types IS DISTINCT FROM OLD.rule_types
    OR NEW.parameters IS DISTINCT FROM OLD.parameters
    OR NEW.provenance IS DISTINCT FROM OLD.provenance
    OR NEW.missing_inputs IS DISTINCT FROM OLD.missing_inputs
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE='23514',
      MESSAGE='calculation_input_snapshot_v4_is_immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS calculation_input_snapshot_v4_immutable
  ON tender.calculation_input_snapshots;
CREATE TRIGGER calculation_input_snapshot_v4_immutable
BEFORE UPDATE ON tender.calculation_input_snapshots
FOR EACH ROW EXECUTE FUNCTION tender.guard_immutable_calculation_input_snapshot();

CREATE OR REPLACE FUNCTION tender.guard_calculation_input_snapshot_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  snapshot_row tender.calculation_input_snapshots%ROWTYPE;
BEGIN
  IF NEW.calculation_input_snapshot_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO snapshot_row
  FROM tender.calculation_input_snapshots
  WHERE id=NEW.calculation_input_snapshot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='calculation_input_snapshot_not_found';
  END IF;
  IF snapshot_row.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR snapshot_row.tender_id IS DISTINCT FROM NEW.tender_id
    OR snapshot_row.company_id IS DISTINCT FROM NEW.company_id
    OR snapshot_row.lot_key IS DISTINCT FROM coalesce(NEW.lot_key,'') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='calculation_input_snapshot_scope_mismatch';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS calculation_input_snapshot_scope_guard
  ON tender.calculations;
CREATE TRIGGER calculation_input_snapshot_scope_guard
BEFORE INSERT OR UPDATE OF calculation_input_snapshot_id,tender_id,company_id,lot_key,tenant_id
ON tender.calculations
FOR EACH ROW EXECUTE FUNCTION tender.guard_calculation_input_snapshot_scope();

INSERT INTO tender.audit_events(action,metadata)
SELECT
  'VERSIONED_CALCULATION_INPUT_SNAPSHOT_INSTALLED',
  jsonb_build_object(
    'release','20260829-versioned-calculation-input-snapshot-157.1',
    'snapshotSchemaVersion',4,
    'historicalSnapshotRowsChanged',false,
    'historicalCalculationsChanged',false,
    'historicalManagementOutputsChanged',false,
    'externalWrite',false,
    'externalSubmission',false,
    'transmitted',false
  )
WHERE NOT EXISTS (
  SELECT 1 FROM app.schema_migrations
  WHERE version='0157-versioned-calculation-input-snapshot'
);

INSERT INTO app.schema_migrations(version,description)
VALUES(
  '0157-versioned-calculation-input-snapshot',
  'Add immutable schema-4 calculation contracts and exact calculation-to-input-snapshot binding without rewriting historical snapshots or calculations'
)
ON CONFLICT(version) DO NOTHING;

COMMIT;
