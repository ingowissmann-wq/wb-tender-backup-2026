BEGIN;
REVOKE ALL ON FUNCTION saas.provision_pending_oidc_identity(text,text,text) FROM saas_runtime;
DROP FUNCTION IF EXISTS saas.provision_pending_oidc_identity(text,text,text);
DO $$ BEGIN
  IF (SELECT count(*) FROM saas.release_161_plan_snapshot)<>3 THEN
    RAISE EXCEPTION 'migration_161_plan_snapshot_incomplete';
  END IF;
END $$;
UPDATE saas.plans p
SET metadata=s.row_data->'metadata',updated_at=(s.row_data->>'updated_at')::timestamptz
FROM saas.release_161_plan_snapshot s WHERE p.code=s.code;
DROP TABLE saas.release_161_plan_snapshot;
COMMIT;
