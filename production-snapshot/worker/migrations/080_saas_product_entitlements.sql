BEGIN;
CREATE SCHEMA IF NOT EXISTS saas;

CREATE TABLE IF NOT EXISTS saas.plans(
  code text PRIMARY KEY CHECK(code IN('CORE','NORMAL','PROFESSIONAL','ENTERPRISE')),
  display_name text NOT NULL,
  description text NOT NULL,
  position integer NOT NULL UNIQUE,
  seat_limit integer CHECK(seat_limit IS NULL OR seat_limit>0),
  company_limit integer CHECK(company_limit IS NULL OR company_limit>0),
  currency char(3) NOT NULL DEFAULT 'EUR',
  recommended_monthly_price_minor integer CHECK(recommended_monthly_price_minor IS NULL OR recommended_monthly_price_minor>=0),
  price_status text NOT NULL DEFAULT 'PLACEHOLDER' CHECK(price_status IN('PLACEHOLDER','APPROVED')),
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS saas.plan_entitlements(
  plan_code text NOT NULL REFERENCES saas.plans(code) ON DELETE CASCADE,
  feature_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  limit_value bigint CHECK(limit_value IS NULL OR limit_value>=0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(plan_code,feature_key)
);

INSERT INTO saas.plans(code,display_name,description,position,seat_limit,company_limit,recommended_monthly_price_minor,price_status,metadata) VALUES
 ('CORE','Core','Tender discovery and deadline fundamentals',10,1,1,4900,'PLACEHOLDER','{"commercial_config_required":true}'),
 ('NORMAL','Normal','Analysis and document workflows',20,3,1,14900,'PLACEHOLDER','{"commercial_config_required":true}'),
 ('PROFESSIONAL','Professional','Tender Autopilot and bid-package workflows',30,10,3,39900,'PLACEHOLDER','{"commercial_config_required":true}'),
 ('ENTERPRISE','Enterprise','Extended governance, integrations and custom limits',40,NULL,NULL,NULL,'PLACEHOLDER','{"commercial_config_required":true,"custom_pricing":true}')
ON CONFLICT(code) DO NOTHING;

WITH entitlement(plan_code,feature_key,enabled,limit_value) AS (VALUES
 ('CORE','discovery.public',true,NULL),('CORE','discovery.saved_searches',true,NULL),('CORE','discovery.alerts',true,NULL),('CORE','workflow.deadlines',true,NULL),('CORE','dashboard.basic',true,NULL),
 ('NORMAL','discovery.public',true,NULL),('NORMAL','discovery.saved_searches',true,NULL),('NORMAL','discovery.alerts',true,NULL),('NORMAL','workflow.deadlines',true,NULL),('NORMAL','dashboard.basic',true,NULL),('NORMAL','analysis.ai_relevance',true,NULL),('NORMAL','analysis.documents',true,NULL),('NORMAL','workflow.required_documents',true,NULL),('NORMAL','workflow.pdf_editor',true,NULL),('NORMAL','workflow.tasks',true,NULL),
 ('PROFESSIONAL','discovery.public',true,NULL),('PROFESSIONAL','discovery.saved_searches',true,NULL),('PROFESSIONAL','discovery.alerts',true,NULL),('PROFESSIONAL','workflow.deadlines',true,NULL),('PROFESSIONAL','dashboard.basic',true,NULL),('PROFESSIONAL','analysis.ai_relevance',true,NULL),('PROFESSIONAL','analysis.documents',true,NULL),('PROFESSIONAL','workflow.required_documents',true,NULL),('PROFESSIONAL','workflow.pdf_editor',true,NULL),('PROFESSIONAL','workflow.tasks',true,NULL),('PROFESSIONAL','autopilot.workflows',true,NULL),('PROFESSIONAL','portal.authorized_retrieval',true,NULL),('PROFESSIONAL','workflow.management_inbox',true,NULL),('PROFESSIONAL','workflow.preflight',true,NULL),('PROFESSIONAL','workflow.bid_package',true,NULL),('PROFESSIONAL','analytics.advanced',true,NULL),
 ('ENTERPRISE','discovery.public',true,NULL),('ENTERPRISE','discovery.saved_searches',true,NULL),('ENTERPRISE','discovery.alerts',true,NULL),('ENTERPRISE','workflow.deadlines',true,NULL),('ENTERPRISE','dashboard.basic',true,NULL),('ENTERPRISE','analysis.ai_relevance',true,NULL),('ENTERPRISE','analysis.documents',true,NULL),('ENTERPRISE','workflow.required_documents',true,NULL),('ENTERPRISE','workflow.pdf_editor',true,NULL),('ENTERPRISE','workflow.tasks',true,NULL),('ENTERPRISE','autopilot.workflows',true,NULL),('ENTERPRISE','portal.authorized_retrieval',true,NULL),('ENTERPRISE','workflow.management_inbox',true,NULL),('ENTERPRISE','workflow.preflight',true,NULL),('ENTERPRISE','workflow.bid_package',true,NULL),('ENTERPRISE','analytics.advanced',true,NULL),('ENTERPRISE','iam.advanced_rbac',true,NULL),('ENTERPRISE','audit.export',true,NULL),('ENTERPRISE','integration.api',true,NULL),('ENTERPRISE','iam.sso_ready',true,NULL)
)
INSERT INTO saas.plan_entitlements(plan_code,feature_key,enabled,limit_value)
SELECT plan_code,feature_key,enabled,limit_value::bigint FROM entitlement
ON CONFLICT(plan_code,feature_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS saas.tenants(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK(slug ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  display_name text NOT NULL CHECK(length(display_name) BETWEEN 2 AND 160),
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','ACTIVE','SUSPENDED','CLOSED')),
  customer_identity_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS saas.pending_registrations(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL UNIQUE REFERENCES saas.tenants(id) ON DELETE CASCADE,
  email text NOT NULL, requested_plan_code text NOT NULL REFERENCES saas.plans(code),
  verification_token_hash text UNIQUE, verification_expires_at timestamptz,
  email_verified_at timestamptz, iam_provisioned_at timestamptz,
  status text NOT NULL DEFAULT 'EMAIL_VERIFICATION_PENDING' CHECK(status IN('EMAIL_VERIFICATION_PENDING','EMAIL_VERIFIED','IAM_PROVISIONING_PENDING','PAYMENT_PENDING','ACTIVATED','EXPIRED','REJECTED')),
  request_ip_hash text, request_user_agent_hash text, attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS saas.tenant_memberships(
  tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK(role IN('OWNER','ADMIN','MEMBER','BILLING')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('INVITED','ACTIVE','SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,user_id)
);
CREATE TABLE IF NOT EXISTS saas.tenant_companies(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  display_name text NOT NULL, tender_company_id uuid UNIQUE REFERENCES tender.enterprise_company_links(company_id),
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','ACTIVE','SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS saas.subscriptions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL UNIQUE REFERENCES saas.tenants(id) ON DELETE CASCADE,
  plan_code text NOT NULL REFERENCES saas.plans(code), status text NOT NULL DEFAULT 'PENDING_PAYMENT' CHECK(status IN('PENDING_PAYMENT','TRIAL_ACTIVE','TRIAL_EXPIRED','ACTIVE','PAST_DUE','SUSPENDED','CANCELED')),
  provider text, provider_customer_ref text, provider_subscription_ref text,
  trial_started_at timestamptz, trial_ends_at timestamptz, trial_claimed_at timestamptz,
  current_period_ends_at timestamptz, suspended_at timestamptz,
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((status<>'TRIAL_ACTIVE') OR (trial_started_at IS NOT NULL AND trial_ends_at IS NOT NULL AND trial_claimed_at IS NOT NULL)),
  CHECK(trial_ends_at IS NULL OR trial_started_at IS NULL OR trial_ends_at=trial_started_at+interval '14 days')
);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_ref_unique ON saas.subscriptions(provider,provider_subscription_ref) WHERE provider_subscription_ref IS NOT NULL;
CREATE TABLE IF NOT EXISTS saas.trial_claims(
  customer_identity_hash text PRIMARY KEY, tenant_id uuid NOT NULL UNIQUE REFERENCES saas.tenants(id), claimed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS saas.billing_events(
  provider text NOT NULL, provider_event_id text NOT NULL, tenant_id uuid NOT NULL REFERENCES saas.tenants(id),
  event_type text NOT NULL, payload_sha256 text NOT NULL, processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,provider_event_id)
);
CREATE TABLE IF NOT EXISTS saas.audit_events(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid REFERENCES saas.tenants(id), actor_user_id uuid REFERENCES iam.users(id),
  action text NOT NULL, target_type text, target_id text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saas_audit_tenant_time ON saas.audit_events(tenant_id,occurred_at DESC);
CREATE TABLE IF NOT EXISTS saas.saved_searches(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES saas.tenants(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES iam.users(id), name text NOT NULL, query jsonb NOT NULL DEFAULT '{}'::jsonb,
  alerts_enabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS saas_saved_search_tenant_owner ON saas.saved_searches(tenant_id,owner_user_id);

CREATE OR REPLACE FUNCTION saas.enforce_plan_limits() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed integer; used integer; tenant uuid;
BEGIN
 tenant:=NEW.tenant_id;
 IF TG_TABLE_NAME='tenant_memberships' AND NEW.status='ACTIVE' THEN
   SELECT p.seat_limit INTO allowed FROM saas.subscriptions s JOIN saas.plans p ON p.code=s.plan_code WHERE s.tenant_id=tenant;
   SELECT count(*) INTO used FROM saas.tenant_memberships WHERE tenant_id=tenant AND status='ACTIVE' AND user_id<>NEW.user_id;
 ELSIF TG_TABLE_NAME='tenant_companies' AND NEW.status='ACTIVE' THEN
   SELECT p.company_limit INTO allowed FROM saas.subscriptions s JOIN saas.plans p ON p.code=s.plan_code WHERE s.tenant_id=tenant;
   SELECT count(*) INTO used FROM saas.tenant_companies WHERE tenant_id=tenant AND status='ACTIVE' AND id<>NEW.id;
 ELSE RETURN NEW; END IF;
 IF allowed IS NOT NULL AND used>=allowed THEN RAISE EXCEPTION 'saas_plan_limit_exceeded'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saas_membership_plan_limit ON saas.tenant_memberships;
CREATE TRIGGER saas_membership_plan_limit BEFORE INSERT OR UPDATE OF status ON saas.tenant_memberships FOR EACH ROW EXECUTE FUNCTION saas.enforce_plan_limits();
DROP TRIGGER IF EXISTS saas_company_plan_limit ON saas.tenant_companies;
CREATE TRIGGER saas_company_plan_limit BEFORE INSERT OR UPDATE OF status ON saas.tenant_companies FOR EACH ROW EXECUTE FUNCTION saas.enforce_plan_limits();

REVOKE ALL ON SCHEMA saas FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA saas FROM PUBLIC;
COMMIT;
