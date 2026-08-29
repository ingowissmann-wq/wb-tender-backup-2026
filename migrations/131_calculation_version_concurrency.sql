BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';

SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:calculation-version-concurrency:131',0));
LOCK TABLE tender.calculations IN SHARE ROW EXCLUSIVE MODE;

-- Renumbering an otherwise unchanged duplicate is metadata repair, not a new
-- commercial calculation. Do not supersede packages/approvals for this update.
ALTER TABLE tender.calculations DISABLE TRIGGER calculation_invalidates_package;

-- Preserve every calculation and every price value. For an already duplicated
-- context/version, retain the referenced row at its original version and move
-- only the other byte-for-byte business record to the next free version.
WITH ranked AS(
  SELECT calculation.*,
    row_number() OVER(
      PARTITION BY calculation.tender_id,calculation.company_id,
        coalesce(calculation.lot_key,''),calculation.version
      ORDER BY CASE WHEN
        EXISTS(SELECT 1 FROM tender.management_outputs output
          WHERE output.calculation_id=calculation.id)
        OR EXISTS(SELECT 1 FROM tender.approval_requests approval
          WHERE approval.calculation_id=calculation.id)
        OR EXISTS(SELECT 1 FROM tender.final_preflight_contexts preflight
          WHERE preflight.calculation_id=calculation.id)
        THEN 1 ELSE 0 END DESC,calculation.created_at,calculation.id
    ) duplicate_rank,
    count(*) OVER(
      PARTITION BY calculation.tender_id,calculation.company_id,
        coalesce(calculation.lot_key,''),calculation.version
    ) duplicate_count
  FROM tender.calculations calculation
), targets AS(
  SELECT * FROM ranked WHERE duplicate_count>1 AND duplicate_rank>1
), minima AS(
  SELECT tender_id,company_id,coalesce(lot_key,'') lot_key,min(version) min_version
  FROM tender.calculations GROUP BY tender_id,company_id,coalesce(lot_key,'')
), renumbered AS(
  SELECT target.id,target.tender_id,target.company_id,target.lot_key,
    target.version old_version,
    least(minimum.min_version,0)-row_number() OVER(
      PARTITION BY target.tender_id,target.company_id,coalesce(target.lot_key,'')
      ORDER BY target.version,target.created_at,target.id
    ) new_version
  FROM targets target
  JOIN minima minimum ON minimum.tender_id=target.tender_id
    AND minimum.company_id=target.company_id
    AND minimum.lot_key=coalesce(target.lot_key,'')
), updated AS(
  UPDATE tender.calculations calculation SET version=renumbered.new_version
  FROM renumbered WHERE calculation.id=renumbered.id
  RETURNING calculation.id,calculation.tender_id,calculation.company_id,
    calculation.lot_key,renumbered.old_version,renumbered.new_version
)
INSERT INTO tender.audit_events(action,tender_id,metadata)
SELECT 'calculation_duplicate_version_repaired',updated.tender_id,
  jsonb_build_object(
    'calculationId',updated.id,
    'companyId',updated.company_id,
    'lotKey',updated.lot_key,
    'oldVersion',updated.old_version,
    'newVersion',updated.new_version,
    'priceDataChanged',false,
    'externalWrite',false
  )
FROM updated;

ALTER TABLE tender.calculations ENABLE TRIGGER calculation_invalidates_package;

CREATE UNIQUE INDEX IF NOT EXISTS calculations_context_version_uq
  ON tender.calculations(tender_id,company_id,coalesce(lot_key,''),version);

INSERT INTO app.schema_migrations(version,description)
VALUES('0131-calculation-version-concurrency',
  'Preserve and deterministically renumber duplicate calculation versions, then enforce exact context/version uniqueness')
ON CONFLICT(version) DO NOTHING;

COMMIT;
