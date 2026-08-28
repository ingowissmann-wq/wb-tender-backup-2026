BEGIN;

-- Additive Green-only commercialization data plane. Public recruiting/career
-- storage is intentionally not referenced by any table or function here.
CREATE TABLE IF NOT EXISTS tenant_portal.csm_interactions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL, interaction_type text NOT NULL CHECK(interaction_type IN('NOTE','CALL','EMAIL','MEETING','REVIEW')),
  subject text NOT NULL, body text NOT NULL DEFAULT '', occurred_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES iam.users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,customer_id) REFERENCES tenant_portal.csm_customers(tenant_id,id) ON DELETE CASCADE
);
ALTER TABLE tenant_portal.csm_customers ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE tenant_portal.csm_customers ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES iam.users(id);
ALTER TABLE tenant_portal.csm_customers ADD COLUMN IF NOT EXISTS lifecycle_stage text NOT NULL DEFAULT 'ONBOARDING';
ALTER TABLE tenant_portal.csm_customers ADD COLUMN IF NOT EXISTS renewal_at date;
ALTER TABLE tenant_portal.csm_customers ADD COLUMN IF NOT EXISTS follow_up_at date;
ALTER TABLE tenant_portal.csm_customers DROP CONSTRAINT IF EXISTS csm_customers_status_chk;
ALTER TABLE tenant_portal.csm_customers ADD CONSTRAINT csm_customers_status_chk CHECK(status IN('ACTIVE','AT_RISK','PAUSED','CHURNED'));
ALTER TABLE tenant_portal.csm_customers DROP CONSTRAINT IF EXISTS csm_customers_health_chk;
ALTER TABLE tenant_portal.csm_customers ADD CONSTRAINT csm_customers_health_chk CHECK(health IN('UNASSESSED','GREEN','AMBER','RED'));
ALTER TABLE tenant_portal.csm_customers DROP CONSTRAINT IF EXISTS csm_customers_lifecycle_chk;
ALTER TABLE tenant_portal.csm_customers ADD CONSTRAINT csm_customers_lifecycle_chk CHECK(lifecycle_stage IN('ONBOARDING','ADOPTION','VALUE','RENEWAL','EXPANSION','CHURNED'));

CREATE TABLE IF NOT EXISTS tenant_portal.csm_service_cases(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL, title text NOT NULL, description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'OPEN' CHECK(status IN('OPEN','IN_PROGRESS','WAITING','RESOLVED','CLOSED')),
  priority text NOT NULL DEFAULT 'NORMAL' CHECK(priority IN('LOW','NORMAL','HIGH','URGENT')),
  owner_user_id uuid REFERENCES iam.users(id), due_at timestamptz, created_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,customer_id) REFERENCES tenant_portal.csm_customers(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS tenant_portal.csm_tasks(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL, case_id uuid, title text NOT NULL, status text NOT NULL DEFAULT 'OPEN' CHECK(status IN('OPEN','DONE','CANCELED')),
  assignee_user_id uuid REFERENCES iam.users(id), due_at timestamptz, created_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,customer_id) REFERENCES tenant_portal.csm_customers(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,case_id) REFERENCES tenant_portal.csm_service_cases(tenant_id,id) ON DELETE SET NULL
);

ALTER TABLE tenant_portal.employee_profiles ADD COLUMN IF NOT EXISTS employee_number text;
ALTER TABLE tenant_portal.employee_profiles ADD COLUMN IF NOT EXISTS employment_status text NOT NULL DEFAULT 'ONBOARDING';
ALTER TABLE tenant_portal.employee_profiles ADD COLUMN IF NOT EXISTS personal_email text;
ALTER TABLE tenant_portal.employee_profiles ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE tenant_portal.employee_profiles ADD COLUMN IF NOT EXISTS job_title text;
ALTER TABLE tenant_portal.employee_profiles ADD COLUMN IF NOT EXISTS team_name text;
ALTER TABLE tenant_portal.employee_profiles ADD COLUMN IF NOT EXISTS manager_profile_id uuid;
ALTER TABLE tenant_portal.employee_profiles ADD COLUMN IF NOT EXISTS start_date date;
ALTER TABLE tenant_portal.employee_profiles ADD COLUMN IF NOT EXISTS end_date date;
ALTER TABLE tenant_portal.employee_profiles DROP CONSTRAINT IF EXISTS employee_profiles_status_chk;
ALTER TABLE tenant_portal.employee_profiles ADD CONSTRAINT employee_profiles_status_chk CHECK(employment_status IN('ONBOARDING','ACTIVE','LEAVE','INACTIVE'));
CREATE UNIQUE INDEX IF NOT EXISTS employee_profiles_number_unique ON tenant_portal.employee_profiles(tenant_id,employee_number) WHERE employee_number IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='employee_profiles_tenant_manager_fk') THEN
    ALTER TABLE tenant_portal.employee_profiles ADD CONSTRAINT employee_profiles_tenant_manager_fk FOREIGN KEY(tenant_id,manager_profile_id) REFERENCES tenant_portal.employee_profiles(tenant_id,id) ON DELETE SET NULL (manager_profile_id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='employee_profiles_tenant_user_fk') THEN
    ALTER TABLE tenant_portal.employee_profiles ADD CONSTRAINT employee_profiles_tenant_user_fk FOREIGN KEY(tenant_id,user_id) REFERENCES saas.tenant_memberships(tenant_id,user_id) ON DELETE SET NULL (user_id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='csm_customers_tenant_owner_fk') THEN
    ALTER TABLE tenant_portal.csm_customers ADD CONSTRAINT csm_customers_tenant_owner_fk FOREIGN KEY(tenant_id,owner_user_id) REFERENCES saas.tenant_memberships(tenant_id,user_id) ON DELETE SET NULL (owner_user_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS tenant_portal.people_onboarding_tasks(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL, title text NOT NULL, status text NOT NULL DEFAULT 'OPEN' CHECK(status IN('OPEN','DONE','NOT_APPLICABLE')),
  assignee_user_id uuid REFERENCES iam.users(id), due_at date, completed_at timestamptz, created_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,employee_id) REFERENCES tenant_portal.employee_profiles(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS tenant_portal.people_document_refs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL, file_id uuid NOT NULL, document_type text NOT NULL, label text NOT NULL,
  created_by uuid REFERENCES iam.users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,employee_id,file_id),
  FOREIGN KEY(tenant_id,employee_id) REFERENCES tenant_portal.employee_profiles(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,file_id) REFERENCES tenant_portal.files(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS tenant_portal.people_absence_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL, absence_type text NOT NULL CHECK(absence_type IN('VACATION','SICK','OTHER')),
  starts_on date NOT NULL, ends_on date NOT NULL, status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','REQUESTED','APPROVED','REJECTED','CANCELED')),
  created_by uuid REFERENCES iam.users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id), CHECK(ends_on>=starts_on), FOREIGN KEY(tenant_id,employee_id) REFERENCES tenant_portal.employee_profiles(tenant_id,id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS saas.tenant_invitations(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  email text NOT NULL, role text NOT NULL CHECK(role IN('ADMIN','MEMBER','BILLING')), token_hash char(64) NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','ACCEPTED','EXPIRED','REVOKED')),
  expires_at timestamptz NOT NULL, invited_by uuid NOT NULL REFERENCES iam.users(id), accepted_user_id uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,email,status)
);
CREATE TABLE IF NOT EXISTS saas.checkout_sessions(
  provider text NOT NULL, provider_checkout_ref text NOT NULL, tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  plan_code text NOT NULL REFERENCES saas.plans(code), status text NOT NULL DEFAULT 'CREATED' CHECK(status IN('CREATED','PAYMENT_CONFIRMED','EXPIRED')),
  created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz, PRIMARY KEY(provider,provider_checkout_ref), UNIQUE(tenant_id,provider_checkout_ref)
);

CREATE TABLE IF NOT EXISTS tenant_portal.storage_audit(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  file_id uuid, action text NOT NULL CHECK(action IN('UPLOAD','DOWNLOAD','DELETE')), actor_user_id uuid REFERENCES iam.users(id),
  occurred_at timestamptz NOT NULL DEFAULT now(), metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='csm_cases_tenant_owner_fk') THEN ALTER TABLE tenant_portal.csm_service_cases ADD CONSTRAINT csm_cases_tenant_owner_fk FOREIGN KEY(tenant_id,owner_user_id) REFERENCES saas.tenant_memberships(tenant_id,user_id) ON DELETE SET NULL (owner_user_id); END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='csm_tasks_tenant_assignee_fk') THEN ALTER TABLE tenant_portal.csm_tasks ADD CONSTRAINT csm_tasks_tenant_assignee_fk FOREIGN KEY(tenant_id,assignee_user_id) REFERENCES saas.tenant_memberships(tenant_id,user_id) ON DELETE SET NULL (assignee_user_id); END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='people_tasks_tenant_assignee_fk') THEN ALTER TABLE tenant_portal.people_onboarding_tasks ADD CONSTRAINT people_tasks_tenant_assignee_fk FOREIGN KEY(tenant_id,assignee_user_id) REFERENCES saas.tenant_memberships(tenant_id,user_id) ON DELETE SET NULL (assignee_user_id); END IF;
END $$;

CREATE INDEX IF NOT EXISTS csm_customers_filter ON tenant_portal.csm_customers(tenant_id,status,health,follow_up_at);
CREATE INDEX IF NOT EXISTS csm_cases_filter ON tenant_portal.csm_service_cases(tenant_id,status,priority,due_at);
CREATE INDEX IF NOT EXISTS people_profiles_filter ON tenant_portal.employee_profiles(tenant_id,employment_status,team_name);

DO $rls$
DECLARE item text;
BEGIN
  FOREACH item IN ARRAY ARRAY['csm_interactions','csm_service_cases','csm_tasks','people_onboarding_tasks','people_document_refs','people_absence_requests','storage_audit']
  LOOP
    EXECUTE format('ALTER TABLE tenant_portal.%I ENABLE ROW LEVEL SECURITY',item);
    EXECUTE format('ALTER TABLE tenant_portal.%I FORCE ROW LEVEL SECURITY',item);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON tenant_portal.%I',item);
    EXECUTE format('CREATE POLICY tenant_isolation ON tenant_portal.%I USING (saas.tenant_matches(tenant_id)) WITH CHECK (saas.tenant_matches(tenant_id))',item);
  END LOOP;
END $rls$;
ALTER TABLE saas.tenant_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.tenant_invitations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON saas.tenant_invitations;
CREATE POLICY tenant_isolation ON saas.tenant_invitations USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
ALTER TABLE saas.checkout_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.checkout_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON saas.checkout_sessions;
CREATE POLICY tenant_isolation ON saas.checkout_sessions USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));

UPDATE saas.modules SET maturity_status=CASE WHEN module_key='control' THEN 'FOUNDATION' ELSE 'PARTIAL' END,metadata=metadata||'{"tenant_owned":true,"migration":"085"}'::jsonb
WHERE module_key IN('csm','people','docs','control');
REVOKE ALL ON ALL TABLES IN SCHEMA tenant_portal FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA saas FROM PUBLIC;
COMMIT;
