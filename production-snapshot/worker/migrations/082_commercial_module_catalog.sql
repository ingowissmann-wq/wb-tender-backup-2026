BEGIN;

-- 080 contained explicitly marked placeholder amounts. They are not approved
-- pricing and must not remain a commercial source of truth.
UPDATE saas.plans SET recommended_monthly_price_minor=NULL,price_status='PLACEHOLDER',
  metadata=metadata||'{"commercial_config_required":true,"pricing_configurable":true}'::jsonb;

-- Canonical commercial catalog. Pricing intentionally remains outside this
-- migration: no approved module price exists in this source.
CREATE TABLE IF NOT EXISTS saas.modules(
  module_key text PRIMARY KEY CHECK(module_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  slug text NOT NULL UNIQUE CHECK(slug ~ '^[a-z][a-z0-9-]{1,63}$'),
  display_name text NOT NULL UNIQUE,
  description text NOT NULL,
  category text NOT NULL,
  maturity_status text NOT NULL CHECK(maturity_status IN('PARTIAL','FOUNDATION','SECURE_EMPTY_SHELL')),
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO saas.modules(module_key,slug,display_name,description,category,maturity_status,metadata) VALUES
 ('tender_scout','tender-scout','WB Tender Scout','Public tender discovery, search, filters, relevance, favorites, deadlines and alerts.','Tender','PARTIAL','{"pricing_configurable":true}'),
 ('tender_autopilot','tender-autopilot','WB Tender Autopilot','Tender analysis, required documents, PDF/form handling, preflight, bid workflow and management inbox.','Tender','PARTIAL','{"pricing_configurable":true}'),
 ('crm','crm','WB CRM','Leads, accounts, contacts, opportunities and sales workflows.','Customer','SECURE_EMPTY_SHELL','{"pricing_configurable":true,"business_source_absent":true}'),
 ('csm','csm','WB CSM','Customer success and service, customer health, service cases, retention and customer development.','Customer','SECURE_EMPTY_SHELL','{"pricing_configurable":true,"business_source_absent":true}'),
 ('flow','flow','WB Flow','Blocks, tasks, workflow and process automation, and internal process building blocks.','Operations','SECURE_EMPTY_SHELL','{"pricing_configurable":true,"business_source_absent":true}'),
 ('people','people','WB People','Employee portal, employee data, onboarding and staff self-service.','People','SECURE_EMPTY_SHELL','{"pricing_configurable":true,"business_source_absent":true}'),
 ('docs','docs','WB Docs','Central documents and files, folders, controlled downloads and document workflows.','Content','SECURE_EMPTY_SHELL','{"pricing_configurable":true,"business_source_absent":true}'),
 ('control','control','WB Control','Administration, roles, permissions, settings, audit and tenant administration.','Administration','FOUNDATION','{"pricing_configurable":true}'),
 ('insights','insights','WB Insights','Dashboards, reports and management analytics.','Analytics','SECURE_EMPTY_SHELL','{"pricing_configurable":true,"business_source_absent":true}'),
 ('connect','connect','WB Connect','API, integrations, SSO and enterprise connectors.','Integration','SECURE_EMPTY_SHELL','{"pricing_configurable":true,"business_source_absent":true}')
ON CONFLICT(module_key) DO UPDATE SET slug=excluded.slug,display_name=excluded.display_name,description=excluded.description,
 category=excluded.category,maturity_status=excluded.maturity_status,metadata=excluded.metadata,updated_at=now();

CREATE TABLE IF NOT EXISTS saas.products(
  product_key text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  display_name text NOT NULL UNIQUE,
  description text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO saas.products(product_key,slug,display_name,description,metadata) VALUES
 ('wb_business_suite','wb-business-suite','WB Business Suite','Complete suite entitlement containing all canonical WB modules.','{"pricing_configurable":true,"full_suite":true}')
ON CONFLICT(product_key) DO UPDATE SET slug=excluded.slug,display_name=excluded.display_name,description=excluded.description,metadata=excluded.metadata;

CREATE TABLE IF NOT EXISTS saas.bundle_modules(
  plan_code text NOT NULL REFERENCES saas.plans(code) ON DELETE CASCADE,
  module_key text NOT NULL REFERENCES saas.modules(module_key) ON DELETE CASCADE,
  PRIMARY KEY(plan_code,module_key)
);
WITH bundle(plan_code,module_key) AS (VALUES
 ('CORE','tender_scout'),('CORE','control'),
 ('NORMAL','tender_scout'),('NORMAL','tender_autopilot'),('NORMAL','flow'),('NORMAL','people'),('NORMAL','docs'),('NORMAL','control'),
 ('PROFESSIONAL','tender_scout'),('PROFESSIONAL','tender_autopilot'),('PROFESSIONAL','crm'),('PROFESSIONAL','csm'),('PROFESSIONAL','flow'),('PROFESSIONAL','people'),('PROFESSIONAL','docs'),('PROFESSIONAL','control'),('PROFESSIONAL','insights'),
 ('ENTERPRISE','tender_scout'),('ENTERPRISE','tender_autopilot'),('ENTERPRISE','crm'),('ENTERPRISE','csm'),('ENTERPRISE','flow'),('ENTERPRISE','people'),('ENTERPRISE','docs'),('ENTERPRISE','control'),('ENTERPRISE','insights'),('ENTERPRISE','connect')
)
INSERT INTO saas.bundle_modules(plan_code,module_key) SELECT plan_code,module_key FROM bundle
ON CONFLICT(plan_code,module_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS saas.module_capabilities(
  module_key text NOT NULL REFERENCES saas.modules(module_key) ON DELETE CASCADE,
  capability_key text NOT NULL CHECK(capability_key ~ '^[a-z][a-z0-9_.]{2,95}$'),
  dependency_only boolean NOT NULL DEFAULT false,
  PRIMARY KEY(module_key,capability_key)
);
INSERT INTO saas.module_capabilities(module_key,capability_key,dependency_only) VALUES
 ('tender_scout','tender.public_discovery',false),
 ('tender_autopilot','tender.autopilot',false),
 ('tender_autopilot','tender.public_discovery',true),
 ('tender_autopilot','docs.object_storage',true),
 ('crm','crm.workspace',false),('csm','csm.workspace',false),('flow','flow.workspace',false),
 ('people','people.workspace',false),('docs','docs.object_storage',false),('control','tenant.administration',false),
 ('insights','insights.workspace',false),('connect','connect.workspace',false)
ON CONFLICT(module_key,capability_key) DO UPDATE SET dependency_only=excluded.dependency_only;

CREATE TABLE IF NOT EXISTS saas.module_dependencies(
  module_key text NOT NULL REFERENCES saas.modules(module_key) ON DELETE CASCADE,
  required_module_key text NOT NULL REFERENCES saas.modules(module_key) ON DELETE RESTRICT,
  exposes_required_module boolean NOT NULL DEFAULT false CHECK(exposes_required_module=false),
  reason text NOT NULL,
  PRIMARY KEY(module_key,required_module_key),
  CHECK(module_key<>required_module_key)
);
INSERT INTO saas.module_dependencies(module_key,required_module_key,exposes_required_module,reason) VALUES
 ('tender_autopilot','tender_scout',false,'Uses public tender discovery capability internally; does not grant the Scout UI or API.'),
 ('tender_autopilot','docs',false,'Uses tenant-bound file storage internally; does not grant the Docs UI or API.')
ON CONFLICT(module_key,required_module_key) DO UPDATE SET exposes_required_module=false,reason=excluded.reason;

CREATE TABLE IF NOT EXISTS saas.tenant_module_entitlements(
  tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  module_key text NOT NULL REFERENCES saas.modules(module_key) ON DELETE RESTRICT,
  enabled boolean NOT NULL,
  source text NOT NULL DEFAULT 'DIRECT' CHECK(source IN('BASELINE','DIRECT','CONTRACT','MIGRATION')),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,module_key),
  CHECK(ends_at IS NULL OR ends_at>starts_at)
);
CREATE TABLE IF NOT EXISTS saas.tenant_product_entitlements(
  tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  product_key text NOT NULL REFERENCES saas.products(product_key) ON DELETE RESTRICT,
  enabled boolean NOT NULL,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,product_key),
  CHECK(ends_at IS NULL OR ends_at>starts_at)
);

ALTER TABLE saas.subscriptions ADD COLUMN IF NOT EXISTS commercial_scope text NOT NULL DEFAULT 'BUNDLE';
ALTER TABLE saas.subscriptions DROP CONSTRAINT IF EXISTS saas_subscriptions_commercial_scope_chk;
ALTER TABLE saas.subscriptions ADD CONSTRAINT saas_subscriptions_commercial_scope_chk CHECK(commercial_scope IN('BUNDLE','MODULES','SUITE'));

ALTER TABLE saas.tenant_module_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.tenant_module_entitlements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON saas.tenant_module_entitlements;
CREATE POLICY tenant_isolation ON saas.tenant_module_entitlements
  USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
ALTER TABLE saas.tenant_product_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.tenant_product_entitlements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON saas.tenant_product_entitlements;
CREATE POLICY tenant_isolation ON saas.tenant_product_entitlements
  USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));

CREATE OR REPLACE FUNCTION saas.module_entitled(candidate uuid,candidate_module text,at_time timestamptz DEFAULT now()) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH subscription_access AS (
    SELECT s.plan_code,s.commercial_scope FROM saas.subscriptions s JOIN saas.tenants t ON t.id=s.tenant_id
    WHERE s.tenant_id=candidate AND saas.tenant_matches(candidate) AND t.status='ACTIVE'
      AND (s.status='ACTIVE' AND (s.current_period_ends_at IS NULL OR s.current_period_ends_at>at_time)
        OR s.status='TRIAL_ACTIVE' AND s.trial_ends_at>at_time)
  ), explicit AS (
    SELECT enabled FROM saas.tenant_module_entitlements
    WHERE tenant_id=candidate AND module_key=candidate_module AND starts_at<=at_time AND (ends_at IS NULL OR ends_at>at_time)
  )
  SELECT EXISTS(SELECT 1 FROM subscription_access) AND coalesce(
    (SELECT enabled FROM explicit),
    EXISTS(SELECT 1 FROM subscription_access s JOIN saas.bundle_modules b ON b.plan_code=s.plan_code WHERE s.commercial_scope='BUNDLE' AND b.module_key=candidate_module)
      OR EXISTS(SELECT 1 FROM subscription_access s JOIN saas.tenant_product_entitlements p ON p.tenant_id=candidate WHERE s.commercial_scope='SUITE' AND p.product_key='wb_business_suite' AND p.enabled AND p.starts_at<=at_time AND (p.ends_at IS NULL OR p.ends_at>at_time)),
    false)
$$;

CREATE OR REPLACE FUNCTION saas.module_capability_allowed(candidate uuid,candidate_module text,candidate_capability text,at_time timestamptz DEFAULT now()) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT saas.module_entitled(candidate,candidate_module,at_time)
    AND EXISTS(SELECT 1 FROM saas.module_capabilities WHERE module_key=candidate_module AND capability_key=candidate_capability)
$$;

CREATE OR REPLACE FUNCTION saas.configure_commercial_entitlements(candidate uuid,candidate_scope text,candidate_modules text[] DEFAULT '{}'::text[]) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE normalized_scope text:=upper(candidate_scope); invalid_module text;
BEGIN
  IF NOT saas.tenant_matches(candidate) THEN RAISE EXCEPTION 'tenant_context_required'; END IF;
  IF normalized_scope NOT IN('BUNDLE','MODULES','SUITE') THEN RAISE EXCEPTION 'commercial_scope_invalid'; END IF;
  IF normalized_scope='MODULES' AND coalesce(cardinality(candidate_modules),0)=0 THEN RAISE EXCEPTION 'individual_module_selection_required'; END IF;
  SELECT requested INTO invalid_module FROM unnest(coalesce(candidate_modules,'{}'::text[])) requested
    LEFT JOIN saas.modules m ON m.module_key=requested AND m.active WHERE m.module_key IS NULL LIMIT 1;
  IF invalid_module IS NOT NULL THEN RAISE EXCEPTION 'module_invalid:%',invalid_module; END IF;
  UPDATE saas.subscriptions SET commercial_scope=normalized_scope,version=version+1,updated_at=now() WHERE tenant_id=candidate;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_missing'; END IF;
  UPDATE saas.tenant_module_entitlements SET enabled=false,updated_at=now()
    WHERE tenant_id=candidate AND source='CONTRACT' AND module_key<>ALL(coalesce(candidate_modules,'{}'::text[]));
  INSERT INTO saas.tenant_module_entitlements(tenant_id,module_key,enabled,source)
    SELECT candidate,module_key,true,'CONTRACT' FROM unnest(coalesce(candidate_modules,'{}'::text[])) module_key
    ON CONFLICT(tenant_id,module_key) DO UPDATE SET enabled=true,source='CONTRACT',starts_at=now(),ends_at=NULL,updated_at=now();
  INSERT INTO saas.tenant_product_entitlements(tenant_id,product_key,enabled)
    VALUES(candidate,'wb_business_suite',normalized_scope='SUITE')
    ON CONFLICT(tenant_id,product_key) DO UPDATE SET enabled=excluded.enabled,starts_at=now(),ends_at=NULL,updated_at=now();
  INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,metadata)
    VALUES(candidate,saas.current_actor_user_id(),'COMMERCIAL_ENTITLEMENTS_CONFIGURED',jsonb_build_object('scope',normalized_scope,'moduleKeys',candidate_modules));
END $$;

-- Provisioning is empty except for the organization/settings records from 081
-- and the minimum Control baseline used by the tenant owner. Purchased modules
-- are granted separately; no WB data or demo rows are copied.
CREATE OR REPLACE FUNCTION tenant_portal.provision_empty_tenant(candidate uuid,organization_name text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF NOT saas.tenant_matches(candidate) THEN RAISE EXCEPTION 'tenant_context_required'; END IF;
  IF organization_name IS NULL OR length(trim(organization_name)) NOT BETWEEN 2 AND 160 THEN RAISE EXCEPTION 'organization_name_invalid'; END IF;
  INSERT INTO tenant_portal.organizations(tenant_id,display_name) VALUES(candidate,trim(organization_name)) ON CONFLICT(tenant_id) DO NOTHING;
  INSERT INTO tenant_portal.tenant_settings(tenant_id,demo_data_enabled) VALUES(candidate,false) ON CONFLICT(tenant_id) DO NOTHING;
  INSERT INTO saas.tenant_module_entitlements(tenant_id,module_key,enabled,source,metadata)
    VALUES(candidate,'control',true,'BASELINE','{"owner_administration_only":true}')
    ON CONFLICT(tenant_id,module_key) DO NOTHING;
END $$;

DO $$
DECLARE existing_tenant uuid;
BEGIN
  FOR existing_tenant IN SELECT id FROM saas.tenants LOOP
    PERFORM set_config('app.tenant_id',existing_tenant::text,true);
    INSERT INTO saas.tenant_module_entitlements(tenant_id,module_key,enabled,source,metadata)
      VALUES(existing_tenant,'control',true,'BASELINE','{"owner_administration_only":true,"migration":"082"}')
      ON CONFLICT(tenant_id,module_key) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id','',true);
END $$;

ALTER TABLE tenant_portal.jobs ADD COLUMN IF NOT EXISTS module_key text REFERENCES saas.modules(module_key);
UPDATE tenant_portal.jobs SET module_key='control' WHERE module_key IS NULL;
ALTER TABLE tenant_portal.jobs ALTER COLUMN module_key SET NOT NULL;
CREATE INDEX IF NOT EXISTS tenant_jobs_module_queue ON tenant_portal.jobs(tenant_id,module_key,status,created_at);

CREATE OR REPLACE FUNCTION tenant_portal.claim_module_job(candidate uuid,candidate_job uuid) RETURNS tenant_portal.jobs
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE claimed tenant_portal.jobs;
BEGIN
  IF NOT saas.tenant_matches(candidate) THEN RAISE EXCEPTION 'tenant_context_required'; END IF;
  SELECT * INTO claimed FROM tenant_portal.jobs WHERE tenant_id=candidate AND id=candidate_job FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_not_found'; END IF;
  IF NOT saas.module_entitled(candidate,claimed.module_key,now()) THEN RAISE EXCEPTION 'module_entitlement_required'; END IF;
  IF claimed.status<>'QUEUED' THEN RAISE EXCEPTION 'job_not_claimable'; END IF;
  UPDATE tenant_portal.jobs SET status='RUNNING',claimed_at=now() WHERE tenant_id=candidate AND id=candidate_job RETURNING * INTO claimed;
  RETURN claimed;
END $$;

REVOKE ALL ON saas.modules,saas.products,saas.bundle_modules,saas.module_capabilities,saas.module_dependencies FROM PUBLIC;
REVOKE ALL ON saas.tenant_module_entitlements,saas.tenant_product_entitlements FROM PUBLIC;
REVOKE ALL ON FUNCTION saas.module_entitled(uuid,text,timestamptz),saas.module_capability_allowed(uuid,text,text,timestamptz),saas.configure_commercial_entitlements(uuid,text,text[]),tenant_portal.claim_module_job(uuid,uuid) FROM PUBLIC;

COMMIT;
