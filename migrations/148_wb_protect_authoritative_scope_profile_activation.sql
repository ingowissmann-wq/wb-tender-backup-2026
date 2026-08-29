BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:wb-protect-scope-profile-activation:148',0));

DO $apply$
DECLARE
  company constant uuid := 'b8bc1f97-60cb-4c5d-b42a-d31d44839c5a';
  profile uuid;
  approver constant uuid := 'ad506fc4-5299-42d4-8320-fbc9ca6e4a28';
  expected_hash constant text := '1adb176774ea65163fed02d1bf7917a020b8179c2a3cde0b030db9f2996cfa9f';
  authority_hash constant text := 'dfbe01ff7d47b290a43410c017cccaf508f15a84036dce76c76850b70873cd60';
  affected integer;
  unrelated_before text;
BEGIN
  SELECT id INTO STRICT profile FROM tender.company_profiles
  WHERE company_id=company AND version=3 AND profile_sha256=expected_hash;
  SELECT encode(digest(coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.company_id,row.version)::text,'[]'),'sha256'),'hex')
  INTO unrelated_before FROM tender.company_profiles row WHERE row.company_id<>company;
  IF NOT EXISTS(SELECT 1 FROM tender.enterprise_company_links WHERE company_id=company
      AND legal_name='WB-Protect & Service GmbH' AND active=true AND tender_profile_id=profile
      AND sector_slug='security' AND sector_status='approved') THEN
    RAISE EXCEPTION 'wb_protect_company_identity_or_scope_mismatch';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM tender.authoritative_company_scope_versions WHERE company_id=company
      AND profile_id=profile AND version_no=1 AND canonical_service='security'
      AND determination_status='ESTABLISHED' AND determined_by_name='Ingo Wissmann'
      AND determined_by_role='Vorstand' AND determined_on=DATE '2026-08-26'
      AND authority_sha256=authority_hash AND external_submission_authorized=false) THEN
    RAISE EXCEPTION 'wb_protect_authoritative_scope_evidence_missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM iam.users WHERE id=approver AND email='ingo.wissmann@wb-holding.ag'
      AND active=true AND mfa_required=true) THEN
    RAISE EXCEPTION 'wb_protect_authoritative_approver_identity_mismatch';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM tender.company_profiles WHERE id=profile AND company_id=company
      AND version=3 AND lifecycle_status='DRAFT' AND status='AUTHORITATIVE_TENDER_SCOPE_CONFIRMED'
      AND service_lines=ARRAY['security']::text[] AND profile_sha256=expected_hash
      AND capabilities->>'technicalMasterMapping'='AUTHORITATIVE_BOARD_SCOPE'
      AND capabilities#>>'{activationStages,calculation}'='BLOCKED') THEN
    RAISE EXCEPTION 'wb_protect_profile_v3_precondition_failed';
  END IF;

  INSERT INTO tender.company_profile_approvals(company_profile_id,profile_sha256,decision,approved_by,
    source_approval_reference,metadata)
  VALUES(profile,expected_hash,'APPROVED',approver,authority_hash,jsonb_build_object(
    'approvalKind','AUTHORITATIVE_TENDER_SCOPE_ONLY','canonicalService','security',
    'determinedBy','Ingo Wissmann','determinedByRole','Vorstand','determinedOn','2026-08-26',
    'authoritySha256',authority_hash,'profileVersion',3,'profileComplete',false,
    'regionConfigurationRequired',true,'calculationProfileApprovalRequired',true,
    'externalSubmissionAuthorized',false,'externalWrite',false,'transmitted',false));
  UPDATE tender.company_profiles SET lifecycle_status='ACTIVE',approved_at=now(),approved_by=approver
  WHERE id=profile AND company_id=company AND version=3 AND lifecycle_status='DRAFT'
    AND profile_sha256=expected_hash;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'wb_protect_profile_v3_activation_failed'; END IF;
  IF unrelated_before IS DISTINCT FROM (SELECT encode(digest(coalesce(jsonb_agg(to_jsonb(row)
      ORDER BY row.company_id,row.version)::text,'[]'),'sha256'),'hex') FROM tender.company_profiles row
      WHERE row.company_id<>company) THEN RAISE EXCEPTION 'unrelated_company_profile_changed'; END IF;
  INSERT INTO tender.audit_events(actor_id,action,metadata) VALUES(approver,
    'WB_PROTECT_AUTHORITATIVE_SCOPE_PROFILE_ACTIVATED',jsonb_build_object(
      'companyId',company,'companyProfileId',profile,'profileVersion',3,'profileSha256',expected_hash,
      'canonicalService','security','authoritySha256',authority_hash,
      'scopeOnly',true,'profileComplete',false,'calculationRemainsBlocked',true,
      'externalSubmissionAuthorized',false,'externalWrite',false,'transmitted',false));
END $apply$;

INSERT INTO app.schema_migrations(version,description) VALUES(
  '0148-wb-protect-authoritative-scope-profile-activation',
  'Activate only WB-Protect profile v3 authoritative security scope while retaining explicit region and calculation blockers')
ON CONFLICT(version) DO NOTHING;
COMMIT;
