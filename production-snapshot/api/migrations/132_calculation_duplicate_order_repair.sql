BEGIN;

SET LOCAL lock_timeout='30s';
SET LOCAL statement_timeout='5min';

SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:calculation-duplicate-order-repair:132',0));
LOCK TABLE tender.calculations IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE tender.calculations DISABLE TRIGGER calculation_invalidates_package;

WITH candidates AS(
  SELECT calculation.id,calculation.tender_id,calculation.company_id,
    coalesce(calculation.lot_key,'') lot_key,calculation.version old_version,
    (repair.metadata->>'oldVersion')::int original_version,
    row_number() OVER(
      PARTITION BY calculation.tender_id,calculation.company_id,coalesce(calculation.lot_key,'')
      ORDER BY calculation.created_at,calculation.id
    ) repair_rank
  FROM tender.audit_events repair
  JOIN tender.calculations calculation
    ON calculation.id=(repair.metadata->>'calculationId')::uuid
  WHERE repair.action='calculation_duplicate_version_repaired'
    AND calculation.version=(repair.metadata->>'newVersion')::int
    AND (repair.metadata->>'newVersion')::int>(repair.metadata->>'oldVersion')::int
    AND NOT EXISTS(
      SELECT 1 FROM tender.audit_events corrected
      WHERE corrected.action='calculation_duplicate_order_repaired'
        AND corrected.metadata->>'calculationId'=calculation.id::text
    )
), minima AS(
  SELECT calculation.tender_id,calculation.company_id,coalesce(calculation.lot_key,'') lot_key,
    min(calculation.version) min_version
  FROM tender.calculations calculation
  JOIN (SELECT DISTINCT tender_id,company_id,lot_key FROM candidates) context
    ON context.tender_id=calculation.tender_id
    AND context.company_id=calculation.company_id
    AND context.lot_key=coalesce(calculation.lot_key,'')
  GROUP BY calculation.tender_id,calculation.company_id,coalesce(calculation.lot_key,'')
), corrected AS(
  UPDATE tender.calculations calculation
  SET version=least(minima.min_version,0)-candidates.repair_rank
  FROM candidates
  JOIN minima ON minima.tender_id=candidates.tender_id
    AND minima.company_id=candidates.company_id AND minima.lot_key=candidates.lot_key
  WHERE calculation.id=candidates.id
  RETURNING calculation.id,calculation.tender_id,calculation.company_id,
    calculation.lot_key,candidates.old_version,calculation.version new_version,
    candidates.original_version
)
INSERT INTO tender.audit_events(action,tender_id,metadata)
SELECT 'calculation_duplicate_order_repaired',corrected.tender_id,
  jsonb_build_object(
    'calculationId',corrected.id,'companyId',corrected.company_id,
    'lotKey',corrected.lot_key,'originalVersion',corrected.original_version,
    'oldRepairVersion',corrected.old_version,'newArchiveVersion',corrected.new_version,
    'priceDataChanged',false,'externalWrite',false
  )
FROM corrected;

ALTER TABLE tender.calculations ENABLE TRIGGER calculation_invalidates_package;

WITH repaired AS(
  SELECT (metadata->>'calculationId')::uuid calculation_id
  FROM tender.audit_events WHERE action='calculation_duplicate_order_repaired'
), rebound AS(
  UPDATE tender.final_preflight_contexts final
  SET calculation_id=management.calculation_id,updated_at=now()
  FROM tender.management_outputs management,
    tender.calculations selected_calculation,
    tender.calculations management_calculation
  WHERE final.is_current AND final.transmitted=false AND final.binding_valid=false
    AND final.management_output_id=management.id
    AND final.calculation_id=selected_calculation.id
    AND management.calculation_id=management_calculation.id
    AND management.calculation_id IS DISTINCT FROM final.calculation_id
    AND selected_calculation.id IN(SELECT calculation_id FROM repaired)
    AND selected_calculation.tender_id=final.tender_id
    AND selected_calculation.company_id=final.company_id
    AND coalesce(selected_calculation.lot_key,'')=coalesce(final.lot_key,'')
    AND management_calculation.tender_id=final.tender_id
    AND management_calculation.company_id=final.company_id
    AND coalesce(management_calculation.lot_key,'')=coalesce(final.lot_key,'')
    AND selected_calculation.totals=management_calculation.totals
    AND selected_calculation.config_id IS NOT DISTINCT FROM management_calculation.config_id
    AND selected_calculation.status=management_calculation.status
    AND selected_calculation.service_line IS NOT DISTINCT FROM management_calculation.service_line
    AND selected_calculation.scenario IS NOT DISTINCT FROM management_calculation.scenario
    AND selected_calculation.calculation_mode IS NOT DISTINCT FROM management_calculation.calculation_mode
    AND selected_calculation.scenario_assumptions IS NOT DISTINCT FROM management_calculation.scenario_assumptions
  RETURNING final.id,final.tender_id,final.company_id,final.lot_key,
    selected_calculation.id old_calculation_id,management.calculation_id new_calculation_id
)
INSERT INTO tender.audit_events(action,tender_id,metadata)
SELECT 'final_preflight_calculation_binding_repaired',rebound.tender_id,
  jsonb_build_object(
    'finalPreflightContextId',rebound.id,'companyId',rebound.company_id,
    'lotKey',rebound.lot_key,'oldCalculationId',rebound.old_calculation_id,
    'newCalculationId',rebound.new_calculation_id,
    'businessDataEqual',true,'externalWrite',false
  )
FROM rebound;

INSERT INTO app.schema_migrations(version,description)
VALUES('0132-calculation-duplicate-order-repair',
  'Keep duplicate-preservation versions outside the active positive sequence and restore only proven equal final-context bindings')
ON CONFLICT(version) DO NOTHING;

COMMIT;
