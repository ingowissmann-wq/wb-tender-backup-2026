BEGIN;

-- Green/candidate-only additive licensing layer. saas.products is the sellable
-- catalog; saas.modules remains the technical module catalog.
ALTER TABLE saas.products ADD COLUMN IF NOT EXISTS product_type text NOT NULL DEFAULT 'BUNDLE';
ALTER TABLE saas.products ADD COLUMN IF NOT EXISTS legacy_plan_code text REFERENCES saas.plans(code);
ALTER TABLE saas.products ADD COLUMN IF NOT EXISTS past_due_access boolean NOT NULL DEFAULT false;
ALTER TABLE saas.products ADD COLUMN IF NOT EXISTS limits jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE saas.products ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE saas.products DROP CONSTRAINT IF EXISTS saas_products_product_type_chk;
ALTER TABLE saas.products ADD CONSTRAINT saas_products_product_type_chk CHECK(product_type IN('STANDALONE','BUNDLE','SUITE','ADD_ON','LEGACY'));

INSERT INTO saas.products(product_key,slug,display_name,description,product_type,active,metadata,limits) VALUES
 ('wb_tender_scout','wb-tender-scout','WB Tender Scout','Standalone public tender discovery with tenant administration.','STANDALONE',true,'{"catalog_version":100}', '{}'),
 ('wb_tender_autopilot','wb-tender-autopilot','WB Tender Autopilot','Standalone Tender Autopilot; discovery and storage dependencies are capability-only.','STANDALONE',true,'{"catalog_version":100,"hidden_dependencies":true}', '{}'),
 ('wb_tender_professional','wb-tender-professional','WB Tender Professional','Tender Scout and Autopilot professional workflow bundle.','BUNDLE',true,'{"catalog_version":100}', '{}'),
 ('wb_tender_enterprise','wb-tender-enterprise','WB Tender Enterprise','Enterprise Tender bundle with configurable limits and Connect.','BUNDLE',true,'{"catalog_version":100,"enterprise":true}', '{"configurable":true,"enterprise":true}'),
 ('wb_crm','wb-crm','WB CRM','Standalone CRM with tenant administration.','STANDALONE',true,'{"catalog_version":100}', '{}'),
 ('wb_csm','wb-csm','WB CSM','Standalone CSM with tenant administration.','STANDALONE',true,'{"catalog_version":100}', '{}'),
 ('wb_flow','wb-flow','WB Flow','Standalone workflow module with tenant administration.','STANDALONE',true,'{"catalog_version":100}', '{}'),
 ('wb_people','wb-people','WB People','Standalone people module with tenant administration.','STANDALONE',true,'{"catalog_version":100}', '{}'),
 ('wb_docs','wb-docs','WB Docs','Standalone documents module with tenant administration.','STANDALONE',true,'{"catalog_version":100}', '{}'),
 ('wb_insights','wb-insights','WB Insights','Standalone insights module with tenant administration.','STANDALONE',true,'{"catalog_version":100}', '{}')
ON CONFLICT(product_key) DO UPDATE SET slug=excluded.slug,display_name=excluded.display_name,description=excluded.description,
 product_type=excluded.product_type,metadata=saas.products.metadata||excluded.metadata,limits=excluded.limits,updated_at=now();
UPDATE saas.products SET product_type='SUITE',limits='{"all_canonical_modules":true}',metadata=metadata||'{"catalog_version":100}' WHERE product_key='wb_business_suite';

-- Compatibility-only products preserve the exact old plan bundles. New offers
-- do not depend on plan names and must target the public products above.
INSERT INTO saas.products(product_key,slug,display_name,description,product_type,legacy_plan_code,active,metadata) VALUES
 ('wb_legacy_core','wb-legacy-core','WB Legacy Core','Compatibility representation of pre-100 CORE subscriptions.','LEGACY','CORE',false,'{"new_sales":false,"migration":100}'),
 ('wb_legacy_normal','wb-legacy-normal','WB Legacy Normal','Compatibility representation of pre-100 NORMAL subscriptions.','LEGACY','NORMAL',false,'{"new_sales":false,"migration":100}'),
 ('wb_legacy_professional','wb-legacy-professional','WB Legacy Professional','Compatibility representation of pre-100 PROFESSIONAL subscriptions.','LEGACY','PROFESSIONAL',false,'{"new_sales":false,"migration":100}'),
 ('wb_legacy_enterprise','wb-legacy-enterprise','WB Legacy Enterprise','Compatibility representation of pre-100 ENTERPRISE subscriptions.','LEGACY','ENTERPRISE',false,'{"new_sales":false,"migration":100}')
ON CONFLICT(product_key) DO UPDATE SET legacy_plan_code=excluded.legacy_plan_code,active=false,metadata=saas.products.metadata||excluded.metadata,updated_at=now();

CREATE TABLE IF NOT EXISTS saas.commercial_product_modules(
  commercial_product_key text NOT NULL REFERENCES saas.products(product_key) ON DELETE CASCADE,
  module_key text NOT NULL REFERENCES saas.modules(module_key) ON DELETE RESTRICT,
  exposure text NOT NULL DEFAULT 'EXPOSED' CHECK(exposure IN('EXPOSED','CAPABILITY_ONLY')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(commercial_product_key,module_key,exposure)
);

WITH configured(product_key,module_key) AS (VALUES
 ('wb_tender_scout','tender_scout'),('wb_tender_scout','control'),
 ('wb_tender_autopilot','tender_autopilot'),('wb_tender_autopilot','control'),
 ('wb_tender_professional','tender_scout'),('wb_tender_professional','tender_autopilot'),('wb_tender_professional','docs'),('wb_tender_professional','flow'),('wb_tender_professional','insights'),('wb_tender_professional','control'),
 ('wb_tender_enterprise','tender_scout'),('wb_tender_enterprise','tender_autopilot'),('wb_tender_enterprise','docs'),('wb_tender_enterprise','flow'),('wb_tender_enterprise','insights'),('wb_tender_enterprise','connect'),('wb_tender_enterprise','control'),
 ('wb_crm','crm'),('wb_crm','control'),('wb_csm','csm'),('wb_csm','control'),('wb_flow','flow'),('wb_flow','control'),
 ('wb_people','people'),('wb_people','control'),('wb_docs','docs'),('wb_docs','control'),('wb_insights','insights'),('wb_insights','control')
)
INSERT INTO saas.commercial_product_modules(commercial_product_key,module_key)
SELECT product_key,module_key FROM configured ON CONFLICT DO NOTHING;
INSERT INTO saas.commercial_product_modules(commercial_product_key,module_key)
SELECT 'wb_business_suite',module_key FROM saas.modules ON CONFLICT DO NOTHING;
INSERT INTO saas.commercial_product_modules(commercial_product_key,module_key)
SELECT 'wb_legacy_'||lower(plan_code),module_key FROM saas.bundle_modules ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS saas.commercial_product_capabilities(
  commercial_product_key text NOT NULL REFERENCES saas.products(product_key) ON DELETE CASCADE,
  capability_key text NOT NULL CHECK(capability_key ~ '^[a-z][a-z0-9_.]{2,95}$'),
  navigation_exposed boolean NOT NULL DEFAULT false CHECK(navigation_exposed=false),
  reason text NOT NULL,
  PRIMARY KEY(commercial_product_key,capability_key)
);
INSERT INTO saas.commercial_product_capabilities(commercial_product_key,capability_key,reason) VALUES
 ('wb_tender_autopilot','tender.public_discovery','Technical discovery dependency; does not expose Tender Scout navigation or direct routes.'),
 ('wb_tender_autopilot','docs.object_storage','Technical storage dependency; does not expose WB Docs navigation or direct routes.')
ON CONFLICT(commercial_product_key,capability_key) DO UPDATE SET navigation_exposed=false,reason=excluded.reason;

CREATE TABLE IF NOT EXISTS saas.stripe_price_offers(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL DEFAULT 'stripe' CHECK(provider='stripe'),
  stripe_price_id text NOT NULL CHECK(stripe_price_id ~ '^price_[A-Za-z0-9_]+$'),
  commercial_product_key text NOT NULL REFERENCES saas.products(product_key) ON DELETE RESTRICT,
  offer_key text NOT NULL, status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','ACTIVE','RETIRED')),
  currency char(3), billing_interval text CHECK(billing_interval IS NULL OR billing_interval IN('MONTH','YEAR','ONE_TIME','CUSTOM')),
  interval_count integer CHECK(interval_count IS NULL OR interval_count>0), amount_minor bigint CHECK(amount_minor IS NULL OR amount_minor>=0),
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb, valid_from timestamptz, retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider,offer_key),
  CHECK(status<>'RETIRED' OR retired_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS stripe_price_one_active_offer ON saas.stripe_price_offers(provider,stripe_price_id) WHERE status='ACTIVE';
CREATE INDEX IF NOT EXISTS stripe_offer_product_status ON saas.stripe_price_offers(commercial_product_key,status);

CREATE TABLE IF NOT EXISTS saas.tenant_product_licenses(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE RESTRICT,
  commercial_product_key text NOT NULL REFERENCES saas.products(product_key) ON DELETE RESTRICT,
  offer_id uuid REFERENCES saas.stripe_price_offers(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK(source IN('STRIPE','MANUAL','MIGRATION')),
  status text NOT NULL CHECK(status IN('PENDING_PAYMENT','TRIAL_ACTIVE','ACTIVE','PAST_DUE','SUSPENDED','CANCELED','EXPIRED')),
  provider text, provider_customer_ref text, provider_subscription_ref text,
  started_at timestamptz NOT NULL DEFAULT now(), trial_started_at timestamptz, trial_ends_at timestamptz,
  current_period_ends_at timestamptz, expires_at timestamptz, canceled_at timestamptz, suspended_at timestamptz,
  manual_reason text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((source='STRIPE' AND provider='stripe' AND offer_id IS NOT NULL AND provider_subscription_ref IS NOT NULL)
     OR (source<>'STRIPE' AND provider IS NULL AND offer_id IS NULL AND provider_customer_ref IS NULL AND provider_subscription_ref IS NULL)),
  CHECK(source<>'MANUAL' OR length(trim(manual_reason))>=8),
  CHECK(trial_ends_at IS NULL OR trial_started_at IS NOT NULL), CHECK(expires_at IS NULL OR expires_at>started_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_license_provider_subscription ON saas.tenant_product_licenses(provider,provider_subscription_ref) WHERE provider_subscription_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS tenant_license_active_lookup ON saas.tenant_product_licenses(tenant_id,status,current_period_ends_at,expires_at);
CREATE INDEX IF NOT EXISTS tenant_license_product_lookup ON saas.tenant_product_licenses(tenant_id,commercial_product_key,status);

CREATE TABLE IF NOT EXISTS saas.license_events(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE RESTRICT,
  license_id uuid REFERENCES saas.tenant_product_licenses(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES iam.users(id), event_type text NOT NULL,
  provider_event_id text, reason text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS license_event_provider_idempotency ON saas.license_events(provider_event_id,event_type) WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS license_event_tenant_time ON saas.license_events(tenant_id,occurred_at DESC);

ALTER TABLE saas.checkout_sessions ADD COLUMN IF NOT EXISTS commercial_product_key text REFERENCES saas.products(product_key);
ALTER TABLE saas.checkout_sessions ADD COLUMN IF NOT EXISTS stripe_price_id text;
ALTER TABLE saas.checkout_sessions ADD COLUMN IF NOT EXISTS offer_id uuid REFERENCES saas.stripe_price_offers(id);

ALTER TABLE saas.tenant_product_licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.tenant_product_licenses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON saas.tenant_product_licenses;
CREATE POLICY tenant_isolation ON saas.tenant_product_licenses USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
ALTER TABLE saas.license_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.license_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON saas.license_events;
CREATE POLICY tenant_isolation ON saas.license_events USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));

CREATE OR REPLACE FUNCTION saas.effective_tenant_modules(candidate uuid,at_time timestamptz DEFAULT now())
RETURNS TABLE(module_key text,exposed boolean,source_products text[],capabilities text[])
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH active_licenses AS (
    SELECT l.id,l.commercial_product_key FROM saas.tenant_product_licenses l
    JOIN saas.products p ON p.product_key=l.commercial_product_key JOIN saas.tenants t ON t.id=l.tenant_id
    WHERE l.tenant_id=candidate AND saas.tenant_matches(candidate) AND t.status='ACTIVE'
      AND (l.status IN('ACTIVE','TRIAL_ACTIVE') OR (l.status='PAST_DUE' AND p.past_due_access))
      AND (l.status<>'TRIAL_ACTIVE' OR l.trial_ends_at>at_time)
      AND (l.current_period_ends_at IS NULL OR l.current_period_ends_at>at_time)
      AND (l.expires_at IS NULL OR l.expires_at>at_time)
  ), inherited AS (
    SELECT pm.module_key,array_agg(DISTINCT al.commercial_product_key ORDER BY al.commercial_product_key) products
    FROM active_licenses al JOIN saas.commercial_product_modules pm ON pm.commercial_product_key=al.commercial_product_key AND pm.exposure='EXPOSED'
    GROUP BY pm.module_key
  ), explicit AS (
    SELECT e.module_key,e.enabled FROM saas.tenant_module_entitlements e
    WHERE e.tenant_id=candidate AND e.starts_at<=at_time AND (e.ends_at IS NULL OR e.ends_at>at_time)
      AND EXISTS(SELECT 1 FROM saas.tenants t WHERE t.id=candidate AND t.status='ACTIVE')
  ), entitled AS (
    SELECT m.module_key,coalesce(i.products,'{}'::text[]) products
    FROM saas.modules m LEFT JOIN inherited i ON i.module_key=m.module_key LEFT JOIN explicit e ON e.module_key=m.module_key
    WHERE coalesce(e.enabled,i.module_key IS NOT NULL,false)
  ), hidden AS (
    SELECT array_agg(DISTINCT pc.capability_key) capabilities FROM active_licenses al
    JOIN saas.commercial_product_capabilities pc ON pc.commercial_product_key=al.commercial_product_key
  )
  SELECT e.module_key,true,e.products,
    (SELECT array_agg(DISTINCT value ORDER BY value) FROM unnest(coalesce(array_agg(mc.capability_key) FILTER(WHERE mc.capability_key IS NOT NULL),'{}') ||
      CASE WHEN e.module_key='tender_autopilot' THEN coalesce((SELECT capabilities FROM hidden),'{}') ELSE '{}' END) value)
  FROM entitled e LEFT JOIN saas.module_capabilities mc ON mc.module_key=e.module_key
  GROUP BY e.module_key,e.products
$$;

CREATE OR REPLACE FUNCTION saas.module_entitled(candidate uuid,candidate_module text,at_time timestamptz DEFAULT now()) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT EXISTS(SELECT 1 FROM saas.effective_tenant_modules(candidate,at_time) e WHERE e.module_key=candidate_module AND e.exposed)
     OR EXISTS(
       SELECT 1 FROM saas.subscriptions s JOIN saas.tenants t ON t.id=s.tenant_id
       WHERE s.tenant_id=candidate AND saas.tenant_matches(candidate) AND t.status='ACTIVE'
         AND NOT EXISTS(SELECT 1 FROM saas.tenant_product_licenses l WHERE l.tenant_id=candidate)
         AND (s.status='ACTIVE' AND (s.current_period_ends_at IS NULL OR s.current_period_ends_at>at_time) OR s.status='TRIAL_ACTIVE' AND s.trial_ends_at>at_time)
         AND coalesce((SELECT enabled FROM saas.tenant_module_entitlements x WHERE x.tenant_id=candidate AND x.module_key=candidate_module AND x.starts_at<=at_time AND (x.ends_at IS NULL OR x.ends_at>at_time)),
           EXISTS(SELECT 1 FROM saas.bundle_modules b WHERE b.plan_code=s.plan_code AND b.module_key=candidate_module),false)
     )
$$;

-- Exact compatibility backfill; no Stripe IDs are invented. Only currently
-- access-bearing subscriptions become migration licenses.
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT s.* FROM saas.subscriptions s WHERE s.status IN('ACTIVE','TRIAL_ACTIVE') LOOP
    PERFORM set_config('app.tenant_id',item.tenant_id::text,true);
    INSERT INTO saas.tenant_product_licenses(tenant_id,commercial_product_key,source,status,started_at,trial_started_at,trial_ends_at,current_period_ends_at,expires_at,metadata)
    SELECT item.tenant_id,'wb_legacy_'||lower(item.plan_code),'MIGRATION',item.status,item.created_at,item.trial_started_at,item.trial_ends_at,item.current_period_ends_at,item.current_period_ends_at,
      jsonb_build_object('migration',100,'legacy_subscription_id',item.id)
    WHERE NOT EXISTS(SELECT 1 FROM saas.tenant_product_licenses l WHERE l.tenant_id=item.tenant_id AND l.source='MIGRATION' AND l.metadata->>'legacy_subscription_id'=item.id::text);
  END LOOP;
  PERFORM set_config('app.tenant_id','',true);
END $$;

REVOKE ALL ON saas.commercial_product_modules,saas.commercial_product_capabilities,saas.stripe_price_offers FROM PUBLIC;
REVOKE ALL ON saas.tenant_product_licenses,saas.license_events FROM PUBLIC;
REVOKE ALL ON FUNCTION saas.effective_tenant_modules(uuid,timestamptz) FROM PUBLIC;
COMMIT;
