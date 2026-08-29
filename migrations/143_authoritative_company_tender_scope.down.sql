BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:authoritative-company-tender-scope:143',0));

DO $rollback$
DECLARE
  requested_company constant uuid := 'b8bc1f97-60cb-4c5d-b42a-d31d44839c5a';
  current_scope tender.authoritative_company_scope_versions%ROWTYPE;
  prior_profile_id uuid;
  reversal_payload jsonb;
BEGIN
  SELECT * INTO current_scope FROM tender.current_authoritative_company_scopes
  WHERE company_id=requested_company;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT id INTO prior_profile_id FROM tender.company_profiles
  WHERE company_id=requested_company AND version<(
    SELECT version FROM tender.company_profiles WHERE id=current_scope.profile_id
  ) ORDER BY version DESC LIMIT 1;
  IF prior_profile_id IS NULL THEN RAISE EXCEPTION 'authoritative_scope_rollback_profile_missing'; END IF;

  -- The determination is immutable. Rollback appends a revocation record and
  -- reverses only the derived operational binding.
  reversal_payload:=jsonb_build_object(
    'schemaVersion',1,'rollbackOf',current_scope.id,'companyId',requested_company,
    'reason','MIGRATION_ROLLBACK','externalSubmissionAuthorized',false
  );
  INSERT INTO tender.authoritative_company_scope_versions(
    tenant_id,company_id,profile_id,predecessor_id,version_no,canonical_service,
    determination_status,determined_by_name,determined_by_role,determined_on,
    source_kind,authority_payload,authority_sha256,external_submission_authorized
  ) VALUES(
    current_scope.tenant_id,current_scope.company_id,current_scope.profile_id,current_scope.id,
    current_scope.version_no+1,current_scope.canonical_service,'REVOKED',current_scope.determined_by_name,
    current_scope.determined_by_role,current_date,'ROLLBACK_REVOCATION',reversal_payload,
    encode(digest(reversal_payload::text,'sha256'),'hex'),false
  );

  DELETE FROM tender.configuration_scopes WHERE company_id=requested_company AND canonical_service='security';
  CREATE OR REPLACE FUNCTION tender.no_enterprise_company_link_mutation()
  RETURNS trigger LANGUAGE plpgsql AS $guard$
  BEGIN
    IF current_setting('app.approved_enterprise_company_scope_apply',true)=
         '143-rollback:b8bc1f97-60cb-4c5d-b42a-d31d44839c5a:security'
       AND OLD.company_id='b8bc1f97-60cb-4c5d-b42a-d31d44839c5a'::uuid
       AND NEW.company_id=OLD.company_id AND NEW.legal_name='WB-Protect & Service GmbH'
       AND NEW.sector_slug IS NULL AND NEW.sector_status='manual-sector-approval-required'
       AND NEW.discovery_status='BLOCKED_PENDING_SERVICE_EVIDENCE'
       AND NEW.matching_status='BLOCKED' AND NEW.calculation_status='BLOCKED'
       AND (to_jsonb(NEW)-ARRAY['tender_profile_id','sector_slug','sector_status','discovery_status','matching_status','calculation_status'])=
           (to_jsonb(OLD)-ARRAY['tender_profile_id','sector_slug','sector_status','discovery_status','matching_status','calculation_status'])
    THEN RETURN NEW;
    END IF;
    RAISE EXCEPTION 'enterprise company links are immutable; use approved rollback/apply';
  END $guard$;
  PERFORM set_config('app.approved_enterprise_company_scope_apply',
    '143-rollback:b8bc1f97-60cb-4c5d-b42a-d31d44839c5a:security',true);
  UPDATE tender.enterprise_company_links SET tender_profile_id=prior_profile_id,sector_slug=NULL,
    sector_status='manual-sector-approval-required',discovery_status='BLOCKED_PENDING_SERVICE_EVIDENCE',
    matching_status='BLOCKED',calculation_status='BLOCKED'
  WHERE company_id=requested_company;
  CREATE OR REPLACE FUNCTION tender.no_enterprise_company_link_mutation()
  RETURNS trigger LANGUAGE plpgsql AS $guard$
  BEGIN
    RAISE EXCEPTION 'enterprise company links are immutable; use approved rollback/apply';
  END $guard$;
  UPDATE tender.company_profiles SET lifecycle_status='SUPERSEDED',valid_until=now()
  WHERE id=current_scope.profile_id;
  INSERT INTO tender.audit_events(action,metadata)
  VALUES('AUTHORITATIVE_COMPANY_TENDER_SCOPE_ROLLED_BACK',reversal_payload||jsonb_build_object(
    'authoritySha256',encode(digest(reversal_payload::text,'sha256'),'hex'),'transmitted',false,'externalWrite',false));
END $rollback$;

DELETE FROM app.schema_migrations WHERE version='0143-authoritative-company-tender-scope';

COMMIT;
