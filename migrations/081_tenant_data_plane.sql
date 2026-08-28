BEGIN;

-- Green-only SaaS tenant data plane.  Every policy below returns no rows when
-- app.tenant_id is absent or invalid.  The application must use SET LOCAL in a
-- transaction; pooled connections must never retain tenant state.
CREATE SCHEMA IF NOT EXISTS tenant_portal;

ALTER TABLE saas.tenants
  ADD COLUMN IF NOT EXISTS tenant_kind text NOT NULL DEFAULT 'CUSTOMER';
ALTER TABLE saas.tenants DROP CONSTRAINT IF EXISTS saas_tenants_kind_chk;
ALTER TABLE saas.tenants ADD CONSTRAINT saas_tenants_kind_chk
  CHECK (tenant_kind IN ('CUSTOMER','INTERNAL'));

CREATE OR REPLACE FUNCTION saas.current_tenant_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE value text;
BEGIN
  value := current_setting('app.tenant_id', true);
  IF value IS NULL OR value = '' THEN RETURN NULL; END IF;
  RETURN value::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION saas.current_actor_user_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE value text;
BEGIN
  value := current_setting('app.actor_user_id', true);
  IF value IS NULL OR value = '' THEN RETURN NULL; END IF;
  RETURN value::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION saas.tenant_matches(candidate uuid) RETURNS boolean
LANGUAGE sql STABLE LEAKPROOF AS $$
  SELECT candidate IS NOT NULL AND candidate = saas.current_tenant_id()
$$;

-- Public catalog additions. Prices remain placeholders until separately
-- approved. Trial access uses exactly the selected plan's entitlements.
WITH entitlement(plan_code,feature_key,enabled,limit_value) AS (VALUES
 ('CORE','admin.dashboard',true,NULL),
 ('CORE','module.employee_portal',true,NULL),
 ('NORMAL','admin.dashboard',true,NULL),
 ('NORMAL','module.employee_portal',true,NULL),
 ('NORMAL','module.blocks',true,NULL),
 ('NORMAL','module.files',true,NULL),
 ('NORMAL','module.tasks',true,NULL),
 ('PROFESSIONAL','admin.dashboard',true,NULL),
 ('PROFESSIONAL','module.employee_portal',true,NULL),
 ('PROFESSIONAL','module.blocks',true,NULL),
 ('PROFESSIONAL','module.files',true,NULL),
 ('PROFESSIONAL','module.tasks',true,NULL),
 ('PROFESSIONAL','module.crm',true,NULL),
 ('PROFESSIONAL','module.csm',true,NULL),
 ('ENTERPRISE','admin.dashboard',true,NULL),
 ('ENTERPRISE','module.employee_portal',true,NULL),
 ('ENTERPRISE','module.blocks',true,NULL),
 ('ENTERPRISE','module.files',true,NULL),
 ('ENTERPRISE','module.tasks',true,NULL),
 ('ENTERPRISE','module.crm',true,NULL),
 ('ENTERPRISE','module.csm',true,NULL),
 ('ENTERPRISE','module.dedicated_storage',true,NULL)
)
INSERT INTO saas.plan_entitlements(plan_code,feature_key,enabled,limit_value)
SELECT plan_code,feature_key,enabled,limit_value::bigint FROM entitlement ON CONFLICT(plan_code,feature_key) DO UPDATE
SET enabled=excluded.enabled,limit_value=excluded.limit_value;

CREATE TABLE IF NOT EXISTS tenant_portal.organizations(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES saas.tenants(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK(length(display_name) BETWEEN 2 AND 160),
  legal_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS tenant_portal.tenant_settings(
  tenant_id uuid PRIMARY KEY REFERENCES saas.tenants(id) ON DELETE CASCADE,
  demo_data_enabled boolean NOT NULL DEFAULT false,
  locale text NOT NULL DEFAULT 'de-DE',
  timezone text NOT NULL DEFAULT 'Europe/Berlin',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tenant_portal.crm_accounts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,stage text NOT NULL DEFAULT 'PROSPECT',synthetic boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES iam.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS tenant_portal.crm_contacts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  account_id uuid,name text NOT NULL,email text,synthetic boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES iam.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,account_id) REFERENCES tenant_portal.crm_accounts(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS tenant_portal.csm_customers(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,health text NOT NULL DEFAULT 'UNASSESSED',synthetic boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES iam.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS tenant_portal.blocks(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  title text NOT NULL,block_type text NOT NULL,content jsonb NOT NULL DEFAULT '{}'::jsonb,synthetic boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES iam.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS tenant_portal.employee_profiles(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  user_id uuid REFERENCES iam.users(id),display_name text NOT NULL,work_email text,synthetic boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,user_id)
);
CREATE TABLE IF NOT EXISTS tenant_portal.files(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  storage_key text NOT NULL,filename text NOT NULL,media_type text NOT NULL,size_bytes bigint NOT NULL CHECK(size_bytes>=0),
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),synthetic boolean NOT NULL DEFAULT false,
  uploaded_by uuid REFERENCES iam.users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,storage_key)
);
CREATE TABLE IF NOT EXISTS tenant_portal.tasks(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  title text NOT NULL,status text NOT NULL DEFAULT 'OPEN',assignee_user_id uuid REFERENCES iam.users(id),synthetic boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES iam.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS tenant_portal.jobs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  job_type text NOT NULL,payload jsonb NOT NULL DEFAULT '{}'::jsonb,status text NOT NULL DEFAULT 'QUEUED',
  created_by uuid REFERENCES iam.users(id),created_at timestamptz NOT NULL DEFAULT now(),claimed_at timestamptz,UNIQUE(tenant_id,id),
  CHECK(status IN('QUEUED','RUNNING','SUCCEEDED','FAILED'))
);

-- Public tender rows may be shared by identifier, but every action, relevance
-- decision, document, credential reference and workflow state lives here.
CREATE TABLE IF NOT EXISTS tenant_portal.tender_workspaces(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  public_tender_id uuid NOT NULL,relevance_status text NOT NULL DEFAULT 'UNREVIEWED',workflow_status text NOT NULL DEFAULT 'DISCOVERED',
  assigned_user_id uuid REFERENCES iam.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),UNIQUE(tenant_id,public_tender_id)
);
CREATE TABLE IF NOT EXISTS tenant_portal.tender_documents(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,storage_key text NOT NULL,filename text NOT NULL,sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid REFERENCES iam.users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,storage_key),
  FOREIGN KEY(tenant_id,workspace_id) REFERENCES tenant_portal.tender_workspaces(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS tenant_portal.portal_credentials(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  portal_key text NOT NULL,secret_reference text NOT NULL,status text NOT NULL DEFAULT 'PENDING',created_by uuid REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,portal_key,secret_reference)
);
CREATE TABLE IF NOT EXISTS tenant_portal.submission_drafts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,status text NOT NULL DEFAULT 'DRAFT',external_transmitted boolean NOT NULL DEFAULT false CHECK(external_transmitted=false),
  created_by uuid REFERENCES iam.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,workspace_id) REFERENCES tenant_portal.tender_workspaces(tenant_id,id) ON DELETE CASCADE,
  CHECK(status IN('DRAFT','INTERNAL_REVIEW','BLOCKED'))
);

CREATE TABLE IF NOT EXISTS saas.legacy_company_tenant_bindings(
  company_id uuid PRIMARY KEY REFERENCES tender.enterprise_company_links(company_id),
  tenant_id uuid NOT NULL REFERENCES saas.tenants(id),
  backfill_run_id uuid NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,company_id)
);
CREATE TABLE IF NOT EXISTS saas.tenant_backfill_runs(
  id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES saas.tenants(id),
  expected_company_count integer NOT NULL CHECK(expected_company_count>=0),
  actual_company_count integer NOT NULL CHECK(actual_company_count>=0),
  source_fingerprint text NOT NULL,executed_by text NOT NULL,
  executed_at timestamptz NOT NULL DEFAULT now(),reversed_at timestamptz
);

CREATE OR REPLACE FUNCTION tenant_portal.provision_empty_tenant(candidate uuid, organization_name text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF NOT saas.tenant_matches(candidate) THEN RAISE EXCEPTION 'tenant_context_required'; END IF;
  IF organization_name IS NULL OR length(trim(organization_name)) NOT BETWEEN 2 AND 160 THEN RAISE EXCEPTION 'organization_name_invalid'; END IF;
  INSERT INTO tenant_portal.organizations(tenant_id,display_name) VALUES(candidate,trim(organization_name)) ON CONFLICT(tenant_id) DO NOTHING;
  INSERT INTO tenant_portal.tenant_settings(tenant_id,demo_data_enabled) VALUES(candidate,false) ON CONFLICT(tenant_id) DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION tenant_portal.enable_synthetic_demo(candidate uuid) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF NOT saas.tenant_matches(candidate) THEN RAISE EXCEPTION 'tenant_context_required'; END IF;
  UPDATE tenant_portal.tenant_settings SET demo_data_enabled=true,updated_at=now() WHERE tenant_id=candidate AND demo_data_enabled=false;
  IF NOT FOUND THEN RAISE EXCEPTION 'demo_enable_requires_explicit_false_to_true_transition'; END IF;
  INSERT INTO tenant_portal.crm_accounts(tenant_id,name,stage,synthetic) VALUES(candidate,'Beispielbetrieb Nord GmbH','PROSPECT',true);
  INSERT INTO tenant_portal.crm_contacts(tenant_id,account_id,name,email,synthetic)
    SELECT candidate,id,'Alex Beispiel','alex.beispiel@example.invalid',true FROM tenant_portal.crm_accounts
    WHERE tenant_id=candidate AND synthetic=true AND name='Beispielbetrieb Nord GmbH';
  INSERT INTO tenant_portal.csm_customers(tenant_id,name,health,synthetic) VALUES(candidate,'Demo Kundschaft West','UNASSESSED',true);
  INSERT INTO tenant_portal.blocks(tenant_id,title,block_type,content,synthetic) VALUES(candidate,'Willkommen im Demo-Arbeitsbereich','TEXT','{"demo":true}',true);
  INSERT INTO tenant_portal.employee_profiles(tenant_id,display_name,work_email,synthetic) VALUES(candidate,'Kim Muster','kim.muster@example.invalid',true);
  INSERT INTO tenant_portal.tasks(tenant_id,title,synthetic) VALUES(candidate,'Synthetischen Demo-Datensatz prüfen',true);
END $$;

-- Apply mandatory RLS mechanically to every tenant-owned table.  There are no
-- internal-admin bypass policies: administrative cross-tenant reporting must
-- use a separately reviewed privileged database role, not the web runtime role.
DO $rls$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT schemaname,tablename FROM pg_tables
    WHERE (schemaname='saas' AND tablename IN('pending_registrations','tenant_memberships','tenant_companies','subscriptions','trial_claims','billing_events','audit_events','saved_searches','legacy_company_tenant_bindings','tenant_backfill_runs'))
       OR schemaname='tenant_portal'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',item.schemaname,item.tablename);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',item.schemaname,item.tablename);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I.%I',item.schemaname,item.tablename);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I.%I USING (saas.tenant_matches(tenant_id)) WITH CHECK (saas.tenant_matches(tenant_id))',item.schemaname,item.tablename);
  END LOOP;
END $rls$;

ALTER TABLE saas.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON saas.tenants;
CREATE POLICY tenant_isolation ON saas.tenants
  USING(saas.tenant_matches(id)) WITH CHECK(saas.tenant_matches(id));

-- Pre-tenant bootstrap is limited to possession of the one-time token hash or
-- the authenticated IAM user. Neither policy permits broad enumeration.
DROP POLICY IF EXISTS verification_bootstrap ON saas.pending_registrations;
CREATE POLICY verification_bootstrap ON saas.pending_registrations
  USING(verification_token_hash IS NOT NULL AND verification_token_hash=current_setting('app.verification_token_hash',true))
  WITH CHECK(tenant_id=saas.current_tenant_id());
DROP POLICY IF EXISTS membership_bootstrap ON saas.tenant_memberships;
CREATE POLICY membership_bootstrap ON saas.tenant_memberships FOR SELECT
  USING(user_id=saas.current_actor_user_id());

REVOKE ALL ON SCHEMA tenant_portal FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA tenant_portal FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA tenant_portal FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA saas FROM PUBLIC;

COMMIT;
