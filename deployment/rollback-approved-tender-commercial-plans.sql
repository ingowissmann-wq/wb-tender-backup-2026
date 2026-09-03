\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE saved jsonb;
BEGIN
  SELECT rows INTO saved
    FROM tender.release_plan_snapshots
   WHERE release_id = current_setting('wb.release_id')
   FOR UPDATE;
  IF saved IS NULL THEN RAISE EXCEPTION 'no exact plan snapshot for release %', current_setting('wb.release_id'); END IF;
  DELETE FROM saas.plans WHERE code IN ('CORE', 'NORMAL', 'PROFESSIONAL', 'ENTERPRISE');
  INSERT INTO saas.plans
  SELECT p.* FROM jsonb_populate_recordset(NULL::saas.plans, saved) AS p;
  DELETE FROM tender.release_plan_snapshots WHERE release_id = current_setting('wb.release_id');
END $$;
COMMIT;
