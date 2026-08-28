BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM saas.tenants WHERE tenant_kind='CUSTOMER' AND status IN('ACTIVE','SUSPENDED')) THEN
    RAISE EXCEPTION 'rollback_refused_customer_lifecycle_exists';
  END IF;
END $$;
DROP TABLE IF EXISTS tenant_portal.storage_audit,tenant_portal.people_absence_requests,tenant_portal.people_document_refs,
 tenant_portal.people_onboarding_tasks,tenant_portal.csm_tasks,tenant_portal.csm_service_cases,tenant_portal.csm_interactions,saas.tenant_invitations;
DROP TABLE IF EXISTS saas.checkout_sessions;
ALTER TABLE tenant_portal.csm_customers DROP COLUMN IF EXISTS status,DROP COLUMN IF EXISTS owner_user_id,DROP COLUMN IF EXISTS lifecycle_stage,
 DROP COLUMN IF EXISTS renewal_at,DROP COLUMN IF EXISTS follow_up_at;
ALTER TABLE tenant_portal.employee_profiles DROP COLUMN IF EXISTS employee_number,DROP COLUMN IF EXISTS employment_status,DROP COLUMN IF EXISTS personal_email,
 DROP COLUMN IF EXISTS phone,DROP COLUMN IF EXISTS job_title,DROP COLUMN IF EXISTS team_name,DROP COLUMN IF EXISTS manager_profile_id,DROP COLUMN IF EXISTS start_date,DROP COLUMN IF EXISTS end_date;
UPDATE saas.modules SET maturity_status='PARTIAL',metadata=metadata-'tenant_owned'-'migration' WHERE module_key IN('csm','people','docs','control');
COMMIT;
