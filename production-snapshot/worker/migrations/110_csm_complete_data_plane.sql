BEGIN;

CREATE TABLE IF NOT EXISTS tenant_portal.csm_contracts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,customer_id uuid NOT NULL,
 contract_reference text NOT NULL,status text NOT NULL DEFAULT 'DRAFT',starts_on date,ends_on date,renewal_notice_on date,metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_by uuid REFERENCES iam.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,customer_id,contract_reference),
 FOREIGN KEY(tenant_id,customer_id) REFERENCES tenant_portal.csm_customers(tenant_id,id) ON DELETE CASCADE,
 CHECK(status IN('DRAFT','ACTIVE','EXPIRING','ENDED','CANCELED')),CHECK(ends_on IS NULL OR starts_on IS NULL OR ends_on>=starts_on)
);
CREATE TABLE IF NOT EXISTS tenant_portal.csm_onboarding_plans(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,customer_id uuid NOT NULL,
 title text NOT NULL,status text NOT NULL DEFAULT 'PLANNED',target_date date,completed_at timestamptz,created_by uuid REFERENCES iam.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,customer_id) REFERENCES tenant_portal.csm_customers(tenant_id,id) ON DELETE CASCADE,
 CHECK(status IN('PLANNED','IN_PROGRESS','BLOCKED','COMPLETED','CANCELED'))
);
CREATE TABLE IF NOT EXISTS tenant_portal.csm_health_assessments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,customer_id uuid NOT NULL,
 health text NOT NULL,score numeric(5,2),evidence jsonb NOT NULL DEFAULT '{}'::jsonb,assessed_by uuid REFERENCES iam.users(id),assessed_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,customer_id) REFERENCES tenant_portal.csm_customers(tenant_id,id) ON DELETE CASCADE,
 CHECK(health IN('UNASSESSED','GREEN','AMBER','RED')),CHECK(score IS NULL OR score BETWEEN 0 AND 100)
);
CREATE TABLE IF NOT EXISTS tenant_portal.csm_playbooks(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,name text NOT NULL,status text NOT NULL DEFAULT 'DRAFT',
 trigger_health text,version integer NOT NULL DEFAULT 1,created_by uuid REFERENCES iam.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,name,version),CHECK(status IN('DRAFT','ACTIVE','RETIRED')),CHECK(trigger_health IS NULL OR trigger_health IN('GREEN','AMBER','RED'))
);
CREATE TABLE IF NOT EXISTS tenant_portal.csm_playbook_steps(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,playbook_id uuid NOT NULL,position integer NOT NULL,title text NOT NULL,
 due_offset_days integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,playbook_id,position),
 FOREIGN KEY(tenant_id,playbook_id) REFERENCES tenant_portal.csm_playbooks(tenant_id,id) ON DELETE CASCADE,CHECK(position>0)
);
CREATE TABLE IF NOT EXISTS tenant_portal.csm_report_snapshots(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,report_type text NOT NULL,
 period_start date,period_end date,payload jsonb NOT NULL,sha256 char(64) NOT NULL,generated_by uuid REFERENCES iam.users(id),generated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,report_type,sha256),CHECK(period_end IS NULL OR period_start IS NULL OR period_end>=period_start)
);

DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['csm_contracts','csm_onboarding_plans','csm_health_assessments','csm_playbooks','csm_playbook_steps','csm_report_snapshots'] LOOP
  EXECUTE format('ALTER TABLE tenant_portal.%I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('ALTER TABLE tenant_portal.%I FORCE ROW LEVEL SECURITY',item);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON tenant_portal.%I',item);
  EXECUTE format('CREATE POLICY tenant_isolation ON tenant_portal.%I USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id))',item);
 END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS csm_contracts_due ON tenant_portal.csm_contracts(tenant_id,status,renewal_notice_on);
CREATE INDEX IF NOT EXISTS csm_onboarding_due ON tenant_portal.csm_onboarding_plans(tenant_id,status,target_date);
CREATE INDEX IF NOT EXISTS csm_health_timeline ON tenant_portal.csm_health_assessments(tenant_id,customer_id,assessed_at DESC);
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA tenant_portal TO tender_api_runtime,saas_runtime;
COMMIT;
