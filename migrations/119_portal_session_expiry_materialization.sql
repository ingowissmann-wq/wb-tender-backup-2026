BEGIN;

CREATE OR REPLACE FUNCTION tender.materialize_expired_portal_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, tender
AS $$
DECLARE
  changed integer;
BEGIN
  UPDATE tender.portal_read_sessions
  SET status='EXPIRED',
      verification_status='EXPIRED_MATERIALIZED',
      revoked_at=coalesce(revoked_at,now())
  WHERE status='ACTIVE' AND expires_at<=now();
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END $$;

REVOKE ALL ON FUNCTION tender.materialize_expired_portal_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tender.materialize_expired_portal_sessions() TO tender_scheduler_runtime;

SELECT tender.materialize_expired_portal_sessions();

INSERT INTO app.schema_migrations(version,description)
VALUES('0119-portal-session-expiry-materialization','Materialize expired portal sessions each scheduler cycle with a narrowly granted fail-closed function')
ON CONFLICT(version) DO NOTHING;

COMMIT;
