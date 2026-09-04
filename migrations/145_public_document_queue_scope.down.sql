BEGIN;
SET LOCAL lock_timeout='30s';
CREATE OR REPLACE FUNCTION tender.reject_unscoped_portal_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action_type IN('TEST_LOGIN','TEST_DOCUMENT_FETCH','RUN_FULL_PIPELINE','DOWNLOAD_DOCUMENTS') AND (
    NEW.company_id IS NULL OR NEW.tender_id IS NULL OR NOT EXISTS(
      SELECT 1 FROM tender.current_registered_tender_company_portals scope
      WHERE scope.tender_id=NEW.tender_id AND scope.company_id=NEW.company_id
        AND (NEW.portal_id IS NULL OR scope.portal_id=NEW.portal_id)
    )) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='registered_portal_scope_required_before_enqueue'; END IF;
  RETURN NEW;
END $$;
INSERT INTO tender.audit_events(action,metadata) VALUES('PUBLIC_DOCUMENT_QUEUE_SCOPE_GUARD_ROLLED_BACK',
  jsonb_build_object('release','20260826-public-document-queue-scope-145.1','retainedData',true,'externalWrite',false,'transmitted',false));
DELETE FROM app.schema_migrations WHERE version='0145-public-document-queue-scope';
COMMIT;
