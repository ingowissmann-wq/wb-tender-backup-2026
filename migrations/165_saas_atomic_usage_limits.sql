BEGIN;
CREATE TABLE saas.release_165_function_snapshot(definition text NOT NULL);
INSERT INTO saas.release_165_function_snapshot SELECT pg_get_functiondef('saas.enforce_plan_limits()'::regprocedure);
REVOKE ALL ON saas.release_165_function_snapshot FROM PUBLIC;

-- Serialize both membership and company reservations per tenant. A concurrent
-- insert must see the committed predecessor before counting available places.
CREATE OR REPLACE FUNCTION saas.enforce_plan_limits() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed integer; used integer; tenant uuid;
BEGIN
 tenant:=NEW.tenant_id;
 IF TG_OP='UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
   RAISE EXCEPTION 'tenant_binding_immutable';
 END IF;
 IF NEW.status<>'ACTIVE' THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('saas-plan:'||tenant::text,0));
 IF TG_TABLE_NAME='tenant_memberships' THEN
   SELECT p.seat_limit INTO allowed FROM saas.subscriptions s JOIN saas.plans p ON p.code=s.plan_code WHERE s.tenant_id=tenant;
   IF NOT FOUND THEN RAISE EXCEPTION 'saas_subscription_required'; END IF;
   SELECT count(*) INTO used FROM saas.tenant_memberships WHERE tenant_id=tenant AND status='ACTIVE' AND user_id<>NEW.user_id;
 ELSIF TG_TABLE_NAME='tenant_companies' THEN
   SELECT p.company_limit INTO allowed FROM saas.subscriptions s JOIN saas.plans p ON p.code=s.plan_code WHERE s.tenant_id=tenant;
   IF NOT FOUND THEN RAISE EXCEPTION 'saas_subscription_required'; END IF;
   SELECT count(*) INTO used FROM saas.tenant_companies WHERE tenant_id=tenant AND status='ACTIVE' AND id<>NEW.id;
 ELSE RAISE EXCEPTION 'saas_limit_table_invalid'; END IF;
 IF allowed IS NOT NULL AND used>=allowed THEN RAISE EXCEPTION 'saas_plan_limit_exceeded'; END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER saas_membership_tenant_binding BEFORE UPDATE OF tenant_id ON saas.tenant_memberships FOR EACH ROW EXECUTE FUNCTION saas.enforce_plan_limits();
CREATE TRIGGER saas_company_tenant_binding BEFORE UPDATE OF tenant_id ON saas.tenant_companies FOR EACH ROW EXECUTE FUNCTION saas.enforce_plan_limits();

CREATE FUNCTION saas.preserve_workspace_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.public_tender_id IS DISTINCT FROM OLD.public_tender_id THEN
  RAISE EXCEPTION 'workspace_tender_binding_immutable';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION saas.preserve_workspace_binding() FROM PUBLIC;
CREATE TRIGGER saas_workspace_binding BEFORE UPDATE ON tenant_portal.tender_workspaces FOR EACH ROW EXECUTE FUNCTION saas.preserve_workspace_binding();

CREATE TABLE saas.automation_usage(
 tenant_id uuid NOT NULL REFERENCES saas.tenants(id),
 month_start date NOT NULL,
 workspace_id uuid NOT NULL,
 first_job_id uuid NOT NULL,
 reserved_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,month_start,workspace_id),
 CHECK(extract(day FROM month_start)=1)
);
ALTER TABLE saas.automation_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.automation_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON saas.automation_usage
 USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
REVOKE ALL ON saas.automation_usage FROM PUBLIC,tender_api_runtime,wb_tender_api_login;
GRANT SELECT ON saas.automation_usage TO tender_api_runtime;

CREATE FUNCTION saas.reserve_automation_usage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas,tenant_portal AS $$
DECLARE workspace uuid; billing_month date; plan text; allowed integer; used integer;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.module_key IS DISTINCT FROM OLD.module_key
     OR (OLD.status<>'QUEUED' AND NEW.payload->>'workspaceId' IS DISTINCT FROM OLD.payload->>'workspaceId')) THEN
   RAISE EXCEPTION 'automation_job_binding_immutable';
 END IF;
 IF NEW.module_key<>'tender_autopilot' OR NEW.status NOT IN('RUNNING','SUCCEEDED') THEN RETURN NEW; END IF;
 IF saas.tenant_matches(NEW.tenant_id) IS DISTINCT FROM true THEN RAISE EXCEPTION 'tenant_context_required'; END IF;
 IF saas.module_entitled(NEW.tenant_id,'tender_autopilot',now()) IS DISTINCT FROM true THEN RAISE EXCEPTION 'module_entitlement_required'; END IF;
 BEGIN workspace:=(NEW.payload->>'workspaceId')::uuid;
 EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'automation_workspace_required'; END;
 IF workspace IS NULL OR NOT EXISTS(SELECT 1 FROM tenant_portal.tender_workspaces WHERE tenant_id=NEW.tenant_id AND id=workspace) THEN
   RAISE EXCEPTION 'automation_workspace_required';
 END IF;
 IF TG_OP='UPDATE' AND OLD.status IN('RUNNING','SUCCEEDED') THEN RETURN NEW; END IF;
 billing_month:=date_trunc('month',now() AT TIME ZONE 'UTC')::date;
 PERFORM pg_advisory_xact_lock(hashtextextended('saas-automation:'||NEW.tenant_id::text,0));
 IF EXISTS(SELECT 1 FROM saas.automation_usage WHERE tenant_id=NEW.tenant_id AND month_start=billing_month AND workspace_id=workspace) THEN RETURN NEW; END IF;
 SELECT plan_code INTO plan FROM saas.subscriptions WHERE tenant_id=NEW.tenant_id;
 CASE plan WHEN 'NORMAL' THEN allowed:=10; WHEN 'PROFESSIONAL' THEN allowed:=25;
 WHEN 'ENTERPRISE' THEN allowed:=NULL; ELSE RAISE EXCEPTION 'automation_plan_required'; END CASE;
 SELECT count(*) INTO used FROM saas.automation_usage WHERE tenant_id=NEW.tenant_id AND month_start=billing_month;
 IF allowed IS NOT NULL AND used>=allowed THEN RAISE EXCEPTION 'saas_monthly_tender_limit_exceeded'; END IF;
 INSERT INTO saas.automation_usage(tenant_id,month_start,workspace_id,first_job_id) VALUES(NEW.tenant_id,billing_month,workspace,NEW.id);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION saas.reserve_automation_usage() FROM PUBLIC;
CREATE TRIGGER saas_automation_usage BEFORE INSERT OR UPDATE ON tenant_portal.jobs
 FOR EACH ROW EXECUTE FUNCTION saas.reserve_automation_usage();
COMMIT;
