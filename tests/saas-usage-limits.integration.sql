\set ON_ERROR_STOP on
BEGIN;
-- This fixture runs only in the isolated rollout database and is rolled back.
DO $$
DECLARE candidate uuid; workspace uuid; first_workspace uuid; plan text; quota integer; seats integer; companies integer; i integer;
BEGIN
 FOREACH plan IN ARRAY ARRAY['NORMAL','PROFESSIONAL','ENTERPRISE'] LOOP
  candidate:=gen_random_uuid();
  INSERT INTO saas.tenants(id,status) VALUES(candidate,'ACTIVE');
  INSERT INTO saas.subscriptions(tenant_id,status,plan_code,current_period_ends_at) VALUES(candidate,'ACTIVE',plan,now()+interval '1 month');
  PERFORM set_config('app.tenant_id',candidate::text,true);
  quota:=CASE plan WHEN 'NORMAL' THEN 10 WHEN 'PROFESSIONAL' THEN 25 ELSE 30 END;
  seats:=CASE plan WHEN 'NORMAL' THEN 3 WHEN 'PROFESSIONAL' THEN 10 ELSE 12 END;
  companies:=CASE plan WHEN 'NORMAL' THEN 1 WHEN 'PROFESSIONAL' THEN 3 ELSE 5 END;
  FOR i IN 1..seats LOOP INSERT INTO saas.tenant_memberships(tenant_id,user_id,status) VALUES(candidate,gen_random_uuid(),'ACTIVE'); END LOOP;
  FOR i IN 1..companies LOOP INSERT INTO saas.tenant_companies(id,tenant_id,status) VALUES(gen_random_uuid(),candidate,'ACTIVE'); END LOOP;
  IF plan<>'ENTERPRISE' THEN
   BEGIN INSERT INTO saas.tenant_memberships(tenant_id,user_id,status) VALUES(candidate,gen_random_uuid(),'ACTIVE'); RAISE EXCEPTION 'seat_overflow_accepted';
   EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'saas_plan_limit_exceeded' THEN RAISE; END IF; END;
   BEGIN INSERT INTO saas.tenant_companies(id,tenant_id,status) VALUES(gen_random_uuid(),candidate,'ACTIVE'); RAISE EXCEPTION 'company_overflow_accepted';
   EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'saas_plan_limit_exceeded' THEN RAISE; END IF; END;
  END IF;
  FOR i IN 1..quota LOOP
   workspace:=gen_random_uuid();IF i=1 THEN first_workspace:=workspace;END IF;
   INSERT INTO tenant_portal.tender_workspaces(id,tenant_id) VALUES(workspace,candidate);
   INSERT INTO tenant_portal.jobs(id,tenant_id,module_key,status,payload) VALUES(gen_random_uuid(),candidate,'tender_autopilot','RUNNING',jsonb_build_object('workspaceId',workspace));
  END LOOP;
  BEGIN
   UPDATE tenant_portal.tender_workspaces SET public_tender_id=gen_random_uuid() WHERE id=first_workspace;
   RAISE EXCEPTION 'workspace_rebinding_accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'workspace_tender_binding_immutable' THEN RAISE; END IF; END;
  -- A second job for the same tender is idempotent for monthly usage.
  INSERT INTO tenant_portal.jobs(id,tenant_id,module_key,status,payload) VALUES(gen_random_uuid(),candidate,'tender_autopilot','RUNNING',jsonb_build_object('workspaceId',first_workspace));
  IF (SELECT count(*) FROM saas.automation_usage WHERE tenant_id=candidate)<>quota THEN RAISE EXCEPTION 'usage_count_invalid'; END IF;
  IF plan<>'ENTERPRISE' THEN
   workspace:=gen_random_uuid();INSERT INTO tenant_portal.tender_workspaces(id,tenant_id) VALUES(workspace,candidate);
   BEGIN
    INSERT INTO tenant_portal.jobs(id,tenant_id,module_key,status,payload) VALUES(gen_random_uuid(),candidate,'tender_autopilot','RUNNING',jsonb_build_object('workspaceId',workspace));
    RAISE EXCEPTION 'monthly_overflow_accepted';
   EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'saas_monthly_tender_limit_exceeded' THEN RAISE; END IF; END;
  END IF;
  BEGIN
   INSERT INTO tenant_portal.jobs(id,tenant_id,module_key,status,payload) VALUES(gen_random_uuid(),candidate,'tender_autopilot','RUNNING',jsonb_build_object('workspaceId',gen_random_uuid()));
   RAISE EXCEPTION 'foreign_workspace_accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'automation_workspace_required' THEN RAISE; END IF; END;
  UPDATE saas.subscriptions SET current_period_ends_at=now()-interval '1 second' WHERE tenant_id=candidate;
  BEGIN
   INSERT INTO tenant_portal.jobs(id,tenant_id,module_key,status,payload) VALUES(gen_random_uuid(),candidate,'tender_autopilot','RUNNING',jsonb_build_object('workspaceId',first_workspace));
   RAISE EXCEPTION 'expired_access_accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'module_entitlement_required' THEN RAISE; END IF; END;
 END LOOP;
END $$;
-- Runtime can inspect its quota but cannot erase reservations to bypass it.
DO $$ BEGIN
 IF has_table_privilege('tender_api_runtime','saas.automation_usage','INSERT,UPDATE,DELETE,TRUNCATE') THEN RAISE EXCEPTION 'usage_ledger_mutable_by_runtime'; END IF;
END $$;
DO $$
DECLARE tenant uuid:=gen_random_uuid(); workspace uuid:=gen_random_uuid(); job uuid:=gen_random_uuid(); claimed tenant_portal.jobs;
BEGIN
 INSERT INTO saas.tenants(id,status) VALUES(tenant,'ACTIVE');
 INSERT INTO saas.subscriptions(tenant_id,status,plan_code,current_period_ends_at) VALUES(tenant,'ACTIVE','NORMAL',now()+interval '1 month');
 PERFORM set_config('app.tenant_id',tenant::text,true);
 INSERT INTO tenant_portal.tender_workspaces(id,tenant_id) VALUES(workspace,tenant);
 INSERT INTO tenant_portal.jobs(id,tenant_id,module_key,status,payload) VALUES(job,tenant,'tender_autopilot','QUEUED',jsonb_build_object('workspaceId',workspace));
 BEGIN
  PERFORM (tenant_portal.claim_module_job(tenant,job)).*;
  RAISE EXCEPTION 'expected_composite_expansion_failure_not_reproduced';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'job_not_claimable' THEN RAISE; END IF; END;
 SELECT * INTO claimed FROM tenant_portal.claim_module_job(tenant,job);
 IF claimed.id IS DISTINCT FROM job OR claimed.status<>'RUNNING' THEN RAISE EXCEPTION 'single_job_claim_failed'; END IF;
END $$;
ROLLBACK;
