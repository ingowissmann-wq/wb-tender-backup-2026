BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:authoritative-company-tender-scope:143',0));

CREATE TABLE IF NOT EXISTS tender.authoritative_company_scope_versions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES tender.enterprise_company_links(company_id),
  profile_id uuid NOT NULL REFERENCES tender.company_profiles(id),
  predecessor_id uuid REFERENCES tender.authoritative_company_scope_versions(id),
  version_no integer NOT NULL CHECK(version_no>0),
  canonical_service text NOT NULL CHECK(canonical_service IN('security','cleaning','facility_management','sicherheitstechnik','emergency_services')),
  determination_status text NOT NULL CHECK(determination_status IN('ESTABLISHED','REVOKED')),
  determined_by_name text NOT NULL,
  determined_by_role text NOT NULL,
  determined_on date NOT NULL,
  source_kind text NOT NULL CHECK(source_kind IN('BOARD_DETERMINATION','ROLLBACK_REVOCATION')),
  authority_payload jsonb NOT NULL,
  authority_sha256 char(64) NOT NULL,
  recorded_by uuid REFERENCES iam.users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  external_submission_authorized boolean NOT NULL DEFAULT false CHECK(external_submission_authorized=false),
  UNIQUE(company_id,version_no),
  UNIQUE(company_id,authority_sha256),
  FOREIGN KEY(tenant_id,company_id) REFERENCES saas.legacy_company_tenant_bindings(tenant_id,company_id)
);

CREATE OR REPLACE FUNCTION tender.reject_authoritative_company_scope_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'authoritative_company_scope_history_is_immutable';
END $$;
REVOKE ALL ON FUNCTION tender.reject_authoritative_company_scope_mutation() FROM PUBLIC;
DROP TRIGGER IF EXISTS authoritative_company_scope_immutable ON tender.authoritative_company_scope_versions;
CREATE TRIGGER authoritative_company_scope_immutable
  BEFORE UPDATE OR DELETE ON tender.authoritative_company_scope_versions
  FOR EACH ROW EXECUTE FUNCTION tender.reject_authoritative_company_scope_mutation();

CREATE OR REPLACE VIEW tender.current_authoritative_company_scopes
WITH (security_invoker=true) AS
SELECT latest.* FROM (
  SELECT DISTINCT ON(determination.company_id) determination.*
  FROM tender.authoritative_company_scope_versions determination
  ORDER BY determination.company_id,determination.version_no DESC
) latest WHERE latest.determination_status='ESTABLISHED';

DO $apply$
DECLARE
  requested_company constant uuid := 'b8bc1f97-60cb-4c5d-b42a-d31d44839c5a';
  requested_name constant text := 'WB-Protect & Service GmbH';
  requested_service constant text := 'security';
  requested_decider constant text := 'Ingo Wissmann';
  requested_role constant text := 'Vorstand';
  requested_date constant date := DATE '2026-08-26';
  company tender.enterprise_company_links%ROWTYPE;
  tenant uuid;
  prior_profile tender.company_profiles%ROWTYPE;
  next_profile tender.company_profiles%ROWTYPE;
  prior_determination tender.authoritative_company_scope_versions%ROWTYPE;
  next_version integer;
  payload jsonb;
  payload_sha char(64);
  next_capabilities jsonb;
  other_company_snapshot text;
BEGIN
  SELECT encode(digest(coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.company_id)::text,'[]'),'sha256'),'hex')
    INTO other_company_snapshot
  FROM tender.enterprise_company_links row
  WHERE row.company_id<>requested_company;

  SELECT * INTO STRICT company
  FROM tender.enterprise_company_links
  WHERE company_id=requested_company
  FOR UPDATE;
  IF company.legal_name<>requested_name OR company.active IS NOT TRUE THEN
    RAISE EXCEPTION 'authoritative_company_identity_mismatch';
  END IF;
  IF company.sector_slug IS NOT NULL AND company.sector_slug<>requested_service THEN
    RAISE EXCEPTION 'existing_company_scope_conflicts_with_board_determination';
  END IF;
  IF EXISTS(SELECT 1 FROM tender.configuration_scopes WHERE company_id=requested_company AND canonical_service<>requested_service) THEN
    RAISE EXCEPTION 'existing_tender_scope_conflicts_with_board_determination';
  END IF;

  SELECT min(binding.tenant_id::text)::uuid INTO tenant
  FROM saas.legacy_company_tenant_bindings binding
  WHERE binding.company_id=requested_company
  HAVING count(DISTINCT binding.tenant_id)=1;
  IF tenant IS NULL THEN RAISE EXCEPTION 'authoritative_company_tenant_binding_required'; END IF;

  SELECT * INTO STRICT prior_profile
  FROM tender.company_profiles
  WHERE id=company.tender_profile_id AND company_id=requested_company
  FOR SHARE;
  SELECT * INTO prior_determination
  FROM tender.current_authoritative_company_scopes
  WHERE company_id=requested_company
  ORDER BY version_no DESC LIMIT 1;
  IF FOUND AND prior_determination.canonical_service<>requested_service THEN
    RAISE EXCEPTION 'active_authoritative_scope_conflict';
  ELSIF FOUND THEN
    RETURN;
  END IF;
  SELECT coalesce(max(version_no),0)+1 INTO next_version
  FROM tender.authoritative_company_scope_versions WHERE company_id=requested_company;

  payload:=jsonb_build_object(
    'schemaVersion',1,'companyId',requested_company,'legalName',requested_name,
    'canonicalService',requested_service,'determinedBy',requested_decider,
    'determinedByRole',requested_role,'determinationDate',requested_date,
    'source','EXPLICIT_AUTHORIZED_USER_INSTRUCTION','recordedDate',current_date,
    'scopeVersion',next_version,'predecessorId',prior_determination.id,
    'changesLimitedTo',jsonb_build_array('authoritative tender scope','company sector binding','derived matching context'),
    'externalSubmissionAuthorized',false
  );
  payload_sha:=encode(digest(payload::text,'sha256'),'hex');
  next_capabilities:=coalesce(prior_profile.capabilities,'{}'::jsonb);
  next_capabilities:=jsonb_set(next_capabilities,'{sector}',to_jsonb(requested_service),true);
  next_capabilities:=jsonb_set(next_capabilities,'{serviceLine}',to_jsonb(requested_service),true);
  next_capabilities:=jsonb_set(next_capabilities,'{activeServices}',jsonb_build_array(requested_service),true);
  next_capabilities:=jsonb_set(next_capabilities,'{candidateServices}',jsonb_build_array(requested_service),true);
  next_capabilities:=jsonb_set(next_capabilities,'{technicalMasterMapping}',to_jsonb('AUTHORITATIVE_BOARD_SCOPE'::text),true);
  next_capabilities:=jsonb_set(next_capabilities,'{verificationStatus}',to_jsonb('LEGAL_ENTITY_AND_AUTHORITATIVE_TENDER_SCOPE_CONFIRMED'::text),true);
  next_capabilities:=jsonb_set(next_capabilities,'{activationStages,discovery}',to_jsonb('ACTIVE'::text),true);
  next_capabilities:=jsonb_set(next_capabilities,'{activationStages,matching}',to_jsonb('PARTIAL'::text),true);
  next_capabilities:=jsonb_set(next_capabilities,'{activationStages,calculation}',to_jsonb('BLOCKED'::text),true);
  next_capabilities:=jsonb_set(next_capabilities,'{missing}',coalesce((
    SELECT jsonb_agg(value ORDER BY ordinal)
    FROM jsonb_array_elements(coalesce(next_capabilities->'missing','[]'::jsonb)) WITH ORDINALITY item(value,ordinal)
    WHERE value<>to_jsonb('Sektorzuordnung'::text)
  ),'[]'::jsonb),true);

  INSERT INTO tender.company_profiles(
    company_id,version,valid_from,name,capabilities,certifications,reference_profile,
    commercial_profile,status,created_by,lifecycle_status,service_lines,regions,
    field_provenance,profile_sha256
  )
  VALUES(
    requested_company,(SELECT coalesce(max(version),0)+1 FROM tender.company_profiles WHERE company_id=requested_company),
    requested_date::timestamptz,prior_profile.name,
    next_capabilities,
    prior_profile.certifications,prior_profile.reference_profile,prior_profile.commercial_profile,
    'AUTHORITATIVE_TENDER_SCOPE_CONFIRMED',NULL,'DRAFT',ARRAY[requested_service],prior_profile.regions,
    coalesce(prior_profile.field_provenance,'{}'::jsonb)||jsonb_build_object('sector',jsonb_build_object(
      'sourceType','BOARD_RESOLUTION','sourceLabel','Autoritative Vorstandsfestlegung',
      'issuer',requested_decider,'issuedAt',requested_date,'validFrom',requested_date,
      'verificationStatus','VERIFIED','authoritySha256',payload_sha)),
    encode(digest(concat_ws('|',requested_company::text,requested_service,requested_date::text,payload_sha,prior_profile.profile_sha256),'sha256'),'hex')
  ) RETURNING * INTO next_profile;

  INSERT INTO tender.authoritative_company_scope_versions(
    tenant_id,company_id,profile_id,predecessor_id,version_no,canonical_service,
    determination_status,determined_by_name,determined_by_role,determined_on,
    source_kind,authority_payload,authority_sha256,external_submission_authorized
  ) VALUES(
    tenant,requested_company,next_profile.id,prior_determination.id,next_version,requested_service,
    'ESTABLISHED',requested_decider,requested_role,requested_date,'BOARD_DETERMINATION',payload,payload_sha,false
  );

  INSERT INTO tender.configuration_scopes(tenant_id,company_id,canonical_service,profile_id)
  VALUES(tenant,requested_company,requested_service,next_profile.id)
  ON CONFLICT(company_id,canonical_service) DO UPDATE SET
    tenant_id=excluded.tenant_id,profile_id=excluded.profile_id,updated_at=now();

  CREATE OR REPLACE FUNCTION tender.no_enterprise_company_link_mutation()
  RETURNS trigger LANGUAGE plpgsql AS $guard$
  BEGIN
    IF current_setting('app.approved_enterprise_company_scope_apply',true)=
         '143:b8bc1f97-60cb-4c5d-b42a-d31d44839c5a:security'
       AND OLD.company_id='b8bc1f97-60cb-4c5d-b42a-d31d44839c5a'::uuid
       AND NEW.company_id=OLD.company_id AND NEW.legal_name='WB-Protect & Service GmbH'
       AND NEW.sector_slug='security' AND NEW.sector_status='approved'
       AND NEW.discovery_status='ACTIVE' AND NEW.matching_status='PARTIAL'
       AND NEW.calculation_status='BLOCKED'
       AND (to_jsonb(NEW)-ARRAY['tender_profile_id','sector_slug','sector_status','discovery_status','matching_status','calculation_status'])=
           (to_jsonb(OLD)-ARRAY['tender_profile_id','sector_slug','sector_status','discovery_status','matching_status','calculation_status'])
    THEN RETURN NEW;
    END IF;
    RAISE EXCEPTION 'enterprise company links are immutable; use approved rollback/apply';
  END $guard$;
  PERFORM set_config('app.approved_enterprise_company_scope_apply',
    '143:b8bc1f97-60cb-4c5d-b42a-d31d44839c5a:security',true);
  UPDATE tender.enterprise_company_links SET
    tender_profile_id=next_profile.id,sector_slug=requested_service,sector_status='approved',
    discovery_status='ACTIVE',matching_status='PARTIAL',calculation_status='BLOCKED'
  WHERE company_id=requested_company;
  IF NOT FOUND THEN RAISE EXCEPTION 'authoritative_company_update_failed'; END IF;
  CREATE OR REPLACE FUNCTION tender.no_enterprise_company_link_mutation()
  RETURNS trigger LANGUAGE plpgsql AS $guard$
  BEGIN
    RAISE EXCEPTION 'enterprise company links are immutable; use approved rollback/apply';
  END $guard$;

  INSERT INTO tender.audit_events(action,metadata)
  VALUES('AUTHORITATIVE_COMPANY_TENDER_SCOPE_RECORDED',payload||jsonb_build_object(
    'profileId',next_profile.id,'profileVersion',next_profile.version,'authoritySha256',payload_sha,
    'transmitted',false,'externalWrite',false));

  IF other_company_snapshot IS DISTINCT FROM (
    SELECT encode(digest(coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.company_id)::text,'[]'),'sha256'),'hex')
    FROM tender.enterprise_company_links row WHERE row.company_id<>requested_company
  ) THEN RAISE EXCEPTION 'unrelated_company_changed'; END IF;
  IF (SELECT count(*) FROM tender.configuration_scopes WHERE company_id=requested_company)<>1 THEN
    RAISE EXCEPTION 'authoritative_tender_scope_not_unique';
  END IF;
END $apply$;

ALTER TABLE tender.authoritative_company_scope_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender.authoritative_company_scope_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS runtime_bound_scope ON tender.authoritative_company_scope_versions;
CREATE POLICY runtime_bound_scope ON tender.authoritative_company_scope_versions
  FOR ALL
  USING(tender.runtime_tenant_allowed(tenant_id) AND tender.runtime_company_allowed(company_id))
  WITH CHECK(tender.runtime_tenant_allowed(tenant_id) AND tender.runtime_company_allowed(company_id));

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tender_api_runtime') THEN
    GRANT USAGE ON SCHEMA tender TO tender_api_runtime;
    GRANT SELECT ON tender.authoritative_company_scope_versions,
      tender.current_authoritative_company_scopes TO tender_api_runtime;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tender_worker_runtime') THEN
    GRANT USAGE ON SCHEMA tender TO tender_worker_runtime;
    GRANT SELECT ON tender.authoritative_company_scope_versions,
      tender.current_authoritative_company_scopes TO tender_worker_runtime;
  END IF;
END $$;

INSERT INTO app.schema_migrations(version,description)
VALUES('0143-authoritative-company-tender-scope',
  'Record the exact WB-Protect & Service board-determined security scope as immutable company history')
ON CONFLICT(version) DO NOTHING;

COMMIT;
