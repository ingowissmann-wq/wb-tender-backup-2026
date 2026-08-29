BEGIN;
DO $$
DECLARE company constant uuid := 'b8bc1f97-60cb-4c5d-b42a-d31d44839c5a';
  profile uuid;
  approver constant uuid := 'ad506fc4-5299-42d4-8320-fbc9ca6e4a28';
BEGIN
  SELECT id INTO STRICT profile FROM tender.company_profiles WHERE company_id=company AND version=3
    AND profile_sha256='1adb176774ea65163fed02d1bf7917a020b8179c2a3cde0b030db9f2996cfa9f';
  UPDATE tender.company_profiles SET lifecycle_status='DRAFT',approved_at=NULL,approved_by=NULL
  WHERE id=profile AND company_id=company AND version=3 AND lifecycle_status='ACTIVE';
  UPDATE tender.company_profile_approvals SET decision='REVOKED',metadata=metadata||jsonb_build_object(
    'rollbackRelease','0148-wb-protect-authoritative-scope-profile-activation','revokedAt',now(),
    'historyRetained',true,'externalWrite',false,'transmitted',false)
  WHERE company_profile_id=profile AND profile_sha256='1adb176774ea65163fed02d1bf7917a020b8179c2a3cde0b030db9f2996cfa9f'
    AND decision='APPROVED' AND source_approval_reference='dfbe01ff7d47b290a43410c017cccaf508f15a84036dce76c76850b70873cd60';
  INSERT INTO tender.audit_events(actor_id,action,metadata) VALUES(approver,
    'WB_PROTECT_AUTHORITATIVE_SCOPE_PROFILE_ACTIVATION_ROLLED_BACK',jsonb_build_object(
      'companyId',company,'companyProfileId',profile,'historyRetained',true,
      'externalWrite',false,'transmitted',false));
END $$;
DELETE FROM app.schema_migrations WHERE version='0148-wb-protect-authoritative-scope-profile-activation';
COMMIT;
