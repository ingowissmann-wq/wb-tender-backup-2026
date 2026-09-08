CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA tender;
CREATE SCHEMA saas;
CREATE SCHEMA iam;
CREATE SCHEMA app;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='saas_runtime') THEN
    CREATE ROLE saas_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wb_tender_api_login') THEN
    CREATE ROLE wb_tender_api_login LOGIN IN ROLE tender_api_runtime;
  END IF;
END $$;
GRANT USAGE ON SCHEMA iam,saas TO tender_api_runtime;
CREATE TABLE tender.autopilot_results(tender_id uuid,company_id uuid,lot_key text,result_version integer);
CREATE TABLE tender.autopilot_queue(tender_id uuid,company_id uuid,lot_key text,created_at timestamptz,action_type text);
CREATE TABLE tender.enrichment_versions(id uuid PRIMARY KEY,tender_id uuid,version integer,historical boolean,created_at timestamptz);
CREATE TABLE tender.enrichment_documents(enrichment_version_id uuid,provenance jsonb);
CREATE TABLE tender.tender_external_links(
  tender_id uuid,role text,final_host text,original_host text,
  verification_status text,evidence jsonb
);
CREATE TABLE tender.portal_registry(
  id uuid PRIMARY KEY,canonical_domain text,authentication_domains text[]
);
CREATE TABLE tender.portal_credential_secrets(
  id uuid PRIMARY KEY,portal_id uuid,status text,revoked_at timestamptz,
  valid_until timestamptz,account_type text,bound_host text,
  authorized_capabilities text[]
);
CREATE TABLE tender.portal_credential_companies(credential_id uuid,company_id uuid,active boolean);
CREATE TABLE tender.enterprise_company_links(company_id uuid PRIMARY KEY,active boolean);
CREATE TABLE app.schema_migrations(version text PRIMARY KEY,description text);
CREATE VIEW tender.current_tender_portal_mapping_truth
WITH (security_barrier=true) AS
WITH current_enrichment AS (
 SELECT DISTINCT ON(version.tender_id) version.id,version.tender_id FROM tender.enrichment_versions version
 WHERE version.historical=false ORDER BY version.tender_id,version.version DESC,version.created_at DESC,version.id DESC
), explicit_profiles AS (
 SELECT current.tender_id,nullif(document.provenance->>'portalId','') portal_key
 FROM current_enrichment current JOIN tender.enrichment_documents document ON document.enrichment_version_id=current.id
 WHERE nullif(document.provenance->>'portalId','') IS NOT NULL
), mapping_count AS (
 SELECT tender_id,count(DISTINCT portal_key)::int portal_mapping_count,min(portal_key) portal_key FROM explicit_profiles GROUP BY tender_id
)
SELECT mapping.tender_id,CASE WHEN mapping.portal_mapping_count=1 THEN portal.id END portal_id,
 mapping.portal_mapping_count,CASE WHEN mapping.portal_mapping_count<>1 THEN 'AMBIGUOUS' WHEN portal.id IS NULL THEN 'UNKNOWN_PROFILE' ELSE 'UNIQUE_CANONICAL_PROFILE' END mapping_status
FROM mapping_count mapping LEFT JOIN tender.portal_registry portal ON portal.id::text=mapping.portal_key;

CREATE VIEW tender.current_registered_tender_company_portals
WITH (security_barrier=true) AS
WITH active_bindings AS (
 SELECT credential.portal_id,scope.company_id,count(DISTINCT credential.id)::int active_credential_count,min(credential.id::text)::uuid credential_id
 FROM tender.portal_credential_secrets credential JOIN tender.portal_credential_companies scope ON scope.credential_id=credential.id AND scope.active=true
 JOIN tender.enterprise_company_links company ON company.company_id=scope.company_id AND company.active=true
 JOIN tender.portal_registry portal ON portal.id=credential.portal_id
 WHERE credential.status='ACTIVE' AND credential.revoked_at IS NULL AND (credential.valid_until IS NULL OR credential.valid_until>now())
 AND (credential.account_type IS NULL OR (credential.bound_host=lower(portal.canonical_domain) AND 'BID_SUBMISSION'=ANY(coalesce(credential.authorized_capabilities,'{}'::text[]))))
 GROUP BY credential.portal_id,scope.company_id HAVING count(DISTINCT credential.id)=1
)
SELECT mapping.tender_id,mapping.portal_id,binding.company_id,binding.credential_id,binding.active_credential_count,mapping.mapping_status
FROM tender.current_tender_portal_mapping_truth mapping JOIN active_bindings binding ON binding.portal_id=mapping.portal_id
WHERE mapping.mapping_status='UNIQUE_CANONICAL_PROFILE';
COMMENT ON VIEW tender.current_registered_tender_company_portals IS
 'Fail-closed exact tender/company/portal scope. Typed credentials additionally require exact host binding and BID_SUBMISSION capability; notice/discovery accounts never constitute bidder registration.';
CREATE TABLE saas.plans(
  code text PRIMARY KEY,
  display_name text NOT NULL,
  description text NOT NULL,
  seat_limit integer,
  company_limit integer,
  recommended_monthly_price_minor bigint,
  price_status text NOT NULL,
  active boolean NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT '2026-09-04T00:00:00Z'
);
INSERT INTO saas.plans(code,display_name,description,seat_limit,company_limit,recommended_monthly_price_minor,price_status,active) VALUES
('CORE','Previous Core','Synthetic pre-rollout row',1,1,100,'PLACEHOLDER',true),
('NORMAL','Previous Normal','Synthetic pre-rollout row',1,1,200,'PLACEHOLDER',false),
('PROFESSIONAL','Previous Professional','Synthetic pre-rollout row',1,1,300,'PLACEHOLDER',false),
('ENTERPRISE','Previous Enterprise','Synthetic pre-rollout row',1,1,400,'PLACEHOLDER',false);
CREATE TABLE iam.users(
  id uuid PRIMARY KEY,
  email text,
  password_hash text,
  active boolean,
  mfa_required boolean,
  mfa_secret_encrypted text,
  mfa_last_counter bigint,
  failed_attempts integer,
  locked_until timestamptz
);
INSERT INTO iam.users(id) VALUES ('00000000-0000-0000-0000-000000000001');
CREATE TABLE saas.pending_registrations(
  tenant_id uuid PRIMARY KEY,
  email text,
  email_verified_at timestamptz,
  status text,
  iam_provisioned_at timestamptz,
  updated_at timestamptz
);
CREATE TABLE saas.checkout_sessions(
  provider text,
  provider_checkout_ref text,
  tenant_id uuid,
  plan_code text,
  status text
);
CREATE TABLE saas.subscriptions(tenant_id uuid PRIMARY KEY,status text);
CREATE TABLE saas.tenant_memberships(
  tenant_id uuid,
  user_id uuid,
  role text,
  status text,
  UNIQUE(tenant_id,user_id)
);
CREATE TABLE saas.iam_subject_bindings(
  issuer text,
  subject text,
  user_id uuid,
  tenant_id uuid,
  email text,
  email_verified_at timestamptz
);
CREATE TABLE saas.tenants(id uuid PRIMARY KEY,status text,updated_at timestamptz);
CREATE TABLE saas.audit_events(
  tenant_id uuid,
  actor_user_id uuid,
  action text,
  target_type text,
  target_id text,
  metadata jsonb
);

-- Existing SaaS schema needed for atomic usage migration and rollback.
ALTER TABLE saas.subscriptions ADD COLUMN plan_code text, ADD COLUMN current_period_ends_at timestamptz;
CREATE TABLE saas.tenant_companies(id uuid PRIMARY KEY,tenant_id uuid,status text,UNIQUE(tenant_id,id));
CREATE SCHEMA tenant_portal;
GRANT USAGE ON SCHEMA tenant_portal TO tender_api_runtime;
CREATE TABLE tenant_portal.jobs(id uuid PRIMARY KEY,tenant_id uuid,module_key text,status text,payload jsonb,claimed_at timestamptz);
CREATE TABLE tenant_portal.files(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,UNIQUE(tenant_id,id));
CREATE TABLE tenant_portal.tender_workspaces(id uuid PRIMARY KEY,tenant_id uuid,public_tender_id uuid,UNIQUE(tenant_id,id));
CREATE FUNCTION saas.tenant_matches(candidate uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT candidate=nullif(current_setting('app.tenant_id',true),'')::uuid
$$;
CREATE FUNCTION saas.module_entitled(candidate uuid,module text,at_time timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM saas.subscriptions WHERE tenant_id=candidate AND status='ACTIVE' AND current_period_ends_at>at_time) AND saas.tenant_matches(candidate)
$$;
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

CREATE TABLE tender.tender_versions(id uuid PRIMARY KEY,tender_id uuid,version integer,created_at timestamptz);
CREATE TABLE tender.tender_portal_resolutions(tender_id uuid,tender_version_id uuid,portal_id uuid,resolution_status text);

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
