BEGIN;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tender_submission_worker_runtime') THEN CREATE ROLE tender_submission_worker_runtime NOLOGIN; END IF; END $$;
GRANT tender_api_runtime TO tender_submission_worker_runtime;
CREATE TABLE tender.submission_dispatches(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,company_id uuid NOT NULL,tender_id uuid NOT NULL REFERENCES tender.tenders(id),lot_key text NOT NULL CHECK(length(lot_key) BETWEEN 1 AND 300),portal_id uuid NOT NULL REFERENCES tender.portal_registry(id),
 origin text NOT NULL CHECK(origin IN('LEGACY','TENANT_PORTAL')),source_id uuid NOT NULL,
 released_by uuid NOT NULL REFERENCES iam.users(id),released_at timestamptz NOT NULL,deadline_at timestamptz NOT NULL,
 package_sha256 text NOT NULL CHECK(package_sha256 ~ '^[a-f0-9]{64}$'),binding jsonb NOT NULL,binding_json text NOT NULL,binding_sha256 text NOT NULL,
 scope_key text NOT NULL UNIQUE CHECK(scope_key ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','READY_FOR_MANAGEMENT','MANAGEMENT_APPROVED_FOR_SUBMISSION','SUBMISSION_QUEUED','SUBMITTING','SUBMITTED','RETRY_REQUIRED','MANUAL_INTERVENTION_REQUIRED','DEADLINE_EXPIRED','CREDENTIALS_REQUIRED','PORTAL_CHANGED')),
 attempt integer NOT NULL DEFAULT 0 CHECK(attempt>=0),next_attempt_at timestamptz NOT NULL DEFAULT now(),lease_owner text,lease_token uuid,lease_expires_at timestamptz,commit_started_at timestamptz,last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,company_id,tender_id,lot_key),
 CHECK(binding_json::jsonb=binding),CHECK(binding_sha256=encode(public.digest(binding_json,'sha256'),'hex')),
 CHECK(binding->>'releaseStatus'='MANAGEMENT_APPROVED_FOR_SUBMISSION'),CHECK(deadline_at>released_at),
 CHECK((binding->>'tenantId')::uuid=tenant_id AND (binding->>'companyId')::uuid=company_id AND (binding->>'tenderId')::uuid=tender_id AND (binding->>'portalId')::uuid=portal_id AND binding->>'lotKey'=lot_key AND (binding->>'releasedBy')::uuid=released_by AND binding->>'packageSha256'=package_sha256)
);
CREATE UNIQUE INDEX submission_dispatch_legal_company_scope ON tender.submission_dispatches(tenant_id,(binding->>'canonicalCompanyId'),tender_id,lot_key);
CREATE INDEX submission_dispatch_claim ON tender.submission_dispatches(status,next_attempt_at) WHERE status IN('SUBMISSION_QUEUED','RETRY_REQUIRED','SUBMITTING');
CREATE TABLE tender.submission_duplicate_attempts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,dispatch_id uuid NOT NULL REFERENCES tender.submission_dispatches(id),actor_id uuid NOT NULL REFERENCES iam.users(id),request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,dispatch_id) REFERENCES tender.submission_dispatches(tenant_id,id)
);
CREATE TABLE tender.submission_dispatch_audit(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,dispatch_id uuid NOT NULL REFERENCES tender.submission_dispatches(id),tenant_id uuid NOT NULL,
 from_status text,to_status text NOT NULL,actor_id uuid,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 previous_sha256 text NOT NULL,event_sha256 text NOT NULL,evidence jsonb NOT NULL,
 UNIQUE(dispatch_id,event_sha256)
);
CREATE TABLE tender.submission_dispatch_receipts(
 dispatch_id uuid PRIMARY KEY REFERENCES tender.submission_dispatches(id),tenant_id uuid NOT NULL,
 portal_reference text NOT NULL CHECK(length(portal_reference) BETWEEN 1 AND 200),submitted_at timestamptz NOT NULL,
 media_type text NOT NULL CHECK(media_type IN('application/pdf','application/json')),receipt_bytes bytea NOT NULL CHECK(octet_length(receipt_bytes) BETWEEN 1 AND 20971520),receipt_sha256 text NOT NULL,
 package_sha256 text NOT NULL,documents jsonb NOT NULL,binding_sha256 text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(receipt_sha256=encode(public.digest(receipt_bytes,'sha256'),'hex')),
 FOREIGN KEY(tenant_id,dispatch_id) REFERENCES tender.submission_dispatches(tenant_id,id)
);
CREATE TABLE tender.submission_dispatch_notifications(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dispatch_id uuid NOT NULL REFERENCES tender.submission_dispatches(id),tenant_id uuid NOT NULL,
 audit_id bigint NOT NULL UNIQUE REFERENCES tender.submission_dispatch_audit(id),recipient_user_id uuid NOT NULL REFERENCES iam.users(id),state text NOT NULL,
 delivery_status text NOT NULL DEFAULT 'PENDING' CHECK(delivery_status IN('PENDING','SENDING','SENT','RETRY_REQUIRED')),
 attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),lease_token uuid,lease_expires_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz,
 FOREIGN KEY(tenant_id,dispatch_id) REFERENCES tender.submission_dispatches(tenant_id,id)
);
CREATE TABLE tender.submission_adapter_releases(
 portal_id uuid PRIMARY KEY REFERENCES tender.portal_registry(id),adapter_id text NOT NULL,adapter_version text NOT NULL,
 enabled boolean NOT NULL DEFAULT false,validation_status text NOT NULL DEFAULT 'NOT_VALIDATED' CHECK(validation_status IN('NOT_VALIDATED','SANDBOX_VALIDATED','PRODUCTION_VALIDATED')),
 profile jsonb NOT NULL,profile_json text NOT NULL,profile_sha256 text NOT NULL,validation_evidence jsonb NOT NULL DEFAULT '{}',validated_at timestamptz,
 CHECK(profile_json::jsonb=profile),CHECK(profile_sha256=encode(public.digest(profile_json,'sha256'),'hex')),
 CHECK(NOT enabled OR (validation_status='PRODUCTION_VALIDATED' AND validated_at IS NOT NULL AND validation_evidence @> '{"login":true,"target":true,"upload":true,"finalization":true,"receipt":true,"nonBindingTest":true}'))
);
CREATE TABLE tender.submission_worker_heartbeats(worker_id text PRIMARY KEY,source_commit text NOT NULL,observed_at timestamptz NOT NULL,last_error text);

CREATE FUNCTION tender.guard_submission_dispatch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE permitted boolean;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'DRAFT' OR NEW.released_by IS DISTINCT FROM nullif(current_setting('app.actor_user_id',true),'')::uuid THEN RAISE EXCEPTION 'submission_release_actor_invalid'; END IF;
  IF NEW.released_at>clock_timestamp()+interval '5 seconds' OR NEW.released_at<clock_timestamp()-interval '5 minutes' OR NEW.deadline_at<=clock_timestamp() THEN RAISE EXCEPTION 'submission_release_time_invalid'; END IF;
  IF NEW.origin='TENANT_PORTAL' AND NOT EXISTS(SELECT 1 FROM saas.tenant_memberships m JOIN saas.tenant_companies c ON c.tenant_id=m.tenant_id JOIN iam.users u ON u.id=m.user_id AND u.active WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.released_by AND m.status='ACTIVE' AND m.role IN('OWNER','ADMIN') AND c.id=NEW.company_id AND c.status='ACTIVE' AND coalesce(c.tender_company_id,c.id)=(NEW.binding->>'canonicalCompanyId')::uuid) THEN RAISE EXCEPTION 'submission_management_permission_required'; END IF;
  IF NEW.origin='LEGACY' AND NOT EXISTS(SELECT 1 FROM iam.users u JOIN iam.user_roles ur ON ur.user_id=u.id JOIN iam.role_permissions rp ON rp.role_id=ur.role_id JOIN iam.permissions p ON p.id=rp.permission_id JOIN iam.tender_identity_scopes scope ON scope.user_id=u.id AND scope.active AND scope.scope_type='company' JOIN tender.configuration_scopes company ON company.company_id=scope.scope_id WHERE u.id=NEW.released_by AND u.active AND p.code='tender.submission.approve' AND company.tenant_id=NEW.tenant_id AND company.company_id=NEW.company_id) THEN RAISE EXCEPTION 'submission_management_permission_required'; END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id,NEW.tenant_id,NEW.company_id,NEW.tender_id,NEW.lot_key,NEW.portal_id,NEW.origin,NEW.source_id,NEW.released_by,NEW.released_at,NEW.deadline_at,NEW.package_sha256,NEW.binding,NEW.binding_json,NEW.binding_sha256,NEW.scope_key,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.company_id,OLD.tender_id,OLD.lot_key,OLD.portal_id,OLD.origin,OLD.source_id,OLD.released_by,OLD.released_at,OLD.deadline_at,OLD.package_sha256,OLD.binding,OLD.binding_json,OLD.binding_sha256,OLD.scope_key,OLD.created_at) THEN RAISE EXCEPTION 'submission_binding_immutable'; END IF;
 IF OLD.commit_started_at IS NULL AND NEW.commit_started_at IS NOT NULL AND (NEW.status<>'SUBMITTING' OR NEW.lease_token IS NULL OR NEW.lease_expires_at<=clock_timestamp() OR NEW.deadline_at<=clock_timestamp()) THEN RAISE EXCEPTION 'submission_commit_not_permitted'; END IF;
 IF OLD.commit_started_at IS NOT NULL AND NEW.commit_started_at IS DISTINCT FROM OLD.commit_started_at THEN RAISE EXCEPTION 'submission_commit_intent_immutable'; END IF;
 IF OLD.status='SUBMITTED' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'submission_receipted_immutable'; END IF;
 IF NEW.status<>OLD.status THEN
  permitted=CASE OLD.status
   WHEN 'DRAFT' THEN NEW.status='READY_FOR_MANAGEMENT'
   WHEN 'READY_FOR_MANAGEMENT' THEN NEW.status='MANAGEMENT_APPROVED_FOR_SUBMISSION'
   WHEN 'MANAGEMENT_APPROVED_FOR_SUBMISSION' THEN NEW.status='SUBMISSION_QUEUED'
   WHEN 'SUBMISSION_QUEUED' THEN NEW.status IN('SUBMITTING','CREDENTIALS_REQUIRED','DEADLINE_EXPIRED','PORTAL_CHANGED','MANUAL_INTERVENTION_REQUIRED','RETRY_REQUIRED')
   WHEN 'SUBMITTING' THEN NEW.status IN('SUBMITTED','CREDENTIALS_REQUIRED','DEADLINE_EXPIRED','PORTAL_CHANGED','MANUAL_INTERVENTION_REQUIRED','RETRY_REQUIRED')
   WHEN 'RETRY_REQUIRED' THEN NEW.status IN('SUBMISSION_QUEUED','SUBMITTING','CREDENTIALS_REQUIRED','DEADLINE_EXPIRED','PORTAL_CHANGED','MANUAL_INTERVENTION_REQUIRED')
   WHEN 'CREDENTIALS_REQUIRED' THEN NEW.status IN('SUBMISSION_QUEUED','DEADLINE_EXPIRED')
   WHEN 'MANUAL_INTERVENTION_REQUIRED' THEN NEW.status='SUBMITTED'
   ELSE false END;
  IF NOT permitted THEN RAISE EXCEPTION 'submission_transition_invalid'; END IF;
 END IF;
 IF NEW.status IN('SUBMISSION_QUEUED','SUBMITTING','RETRY_REQUIRED') AND OLD.commit_started_at IS NOT NULL AND NEW.status<>OLD.status THEN RAISE EXCEPTION 'submission_commit_retry_forbidden'; END IF;
 IF NEW.status='SUBMITTED' AND NOT EXISTS(SELECT 1 FROM tender.submission_dispatch_receipts r WHERE r.dispatch_id=NEW.id AND r.tenant_id=NEW.tenant_id AND r.binding_sha256=NEW.binding_sha256 AND r.package_sha256=NEW.package_sha256 AND r.submitted_at>=NEW.released_at AND r.submitted_at<=NEW.deadline_at) THEN RAISE EXCEPTION 'submission_receipt_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_submission_dispatch BEFORE INSERT OR UPDATE ON tender.submission_dispatches FOR EACH ROW EXECUTE FUNCTION tender.guard_submission_dispatch();
CREATE FUNCTION tender.audit_submission_dispatch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous text; event jsonb; event_id bigint; old_state text;
BEGIN
 IF TG_OP='UPDATE' AND NEW.status=OLD.status THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN old_state=OLD.status; END IF;
 SELECT event_sha256 INTO previous FROM tender.submission_dispatch_audit WHERE dispatch_id=NEW.id ORDER BY id DESC LIMIT 1;
 previous=coalesce(previous,repeat('0',64));
 event=jsonb_build_object('dispatchId',NEW.id,'tenantId',NEW.tenant_id,'companyId',NEW.company_id,'tenderId',NEW.tender_id,'lotKey',NEW.lot_key,'portalId',NEW.portal_id,'bindingSha256',NEW.binding_sha256,'packageSha256',NEW.package_sha256,'from',old_state,'to',NEW.status,'at',clock_timestamp(),'error',NEW.last_error,'attempt',NEW.attempt);
 INSERT INTO tender.submission_dispatch_audit(dispatch_id,tenant_id,from_status,to_status,actor_id,previous_sha256,event_sha256,evidence)
 VALUES(NEW.id,NEW.tenant_id,old_state,NEW.status,nullif(current_setting('app.actor_user_id',true),'')::uuid,previous,encode(public.digest(previous||event::text,'sha256'),'hex'),event) RETURNING id INTO event_id;
 IF NEW.status IN('SUBMITTED','CREDENTIALS_REQUIRED','DEADLINE_EXPIRED','PORTAL_CHANGED','MANUAL_INTERVENTION_REQUIRED','RETRY_REQUIRED') THEN
  INSERT INTO tender.submission_dispatch_notifications(dispatch_id,tenant_id,audit_id,recipient_user_id,state) VALUES(NEW.id,NEW.tenant_id,event_id,NEW.released_by,NEW.status);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER audit_submission_dispatch AFTER INSERT OR UPDATE ON tender.submission_dispatches FOR EACH ROW EXECUTE FUNCTION tender.audit_submission_dispatch();
CREATE FUNCTION tender.immutable_submission_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'submission_evidence_immutable'; END $$;
CREATE TRIGGER immutable_submission_dispatch_audit BEFORE UPDATE OR DELETE ON tender.submission_dispatch_audit FOR EACH ROW EXECUTE FUNCTION tender.immutable_submission_evidence();
CREATE TRIGGER immutable_submission_duplicate_attempts BEFORE UPDATE OR DELETE ON tender.submission_duplicate_attempts FOR EACH ROW EXECUTE FUNCTION tender.immutable_submission_evidence();
CREATE TRIGGER immutable_submission_dispatch_receipts BEFORE UPDATE OR DELETE ON tender.submission_dispatch_receipts FOR EACH ROW EXECUTE FUNCTION tender.immutable_submission_evidence();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['submission_dispatches','submission_dispatch_audit','submission_dispatch_receipts','submission_dispatch_notifications','submission_duplicate_attempts'] LOOP
  EXECUTE format('ALTER TABLE tender.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE tender.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON tender.%I USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id))',t);
  EXECUTE format('REVOKE ALL ON tender.%I FROM PUBLIC,tender_api_runtime,wb_tender_api_login',t);
  EXECUTE format('GRANT SELECT ON tender.%I TO tender_api_runtime',t);
 END LOOP;
END $$;
GRANT INSERT ON tender.submission_dispatches,tender.submission_duplicate_attempts TO tender_api_runtime;
GRANT UPDATE(status,updated_at) ON tender.submission_dispatches TO tender_api_runtime;
GRANT UPDATE(status,attempt,next_attempt_at,lease_owner,lease_token,lease_expires_at,commit_started_at,last_error,updated_at) ON tender.submission_dispatches TO tender_submission_worker_runtime;
GRANT INSERT ON tender.submission_dispatch_receipts TO tender_submission_worker_runtime;
GRANT SELECT ON tender.submission_adapter_releases TO tender_api_runtime;
GRANT SELECT,INSERT,UPDATE ON tender.submission_worker_heartbeats TO tender_submission_worker_runtime;
GRANT UPDATE(delivery_status,attempts,next_attempt_at,lease_token,lease_expires_at,sent_at) ON tender.submission_dispatch_notifications TO tender_submission_worker_runtime;

-- Called on a dedicated connection held by one worker until pg_advisory_unlock.
CREATE FUNCTION tender.claim_submission_dispatch(worker text) RETURNS TABLE(dispatch_id uuid,tenant_id uuid,lease_token uuid,lock_key bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE candidate record; token uuid; key bigint;
BEGIN
 UPDATE tender.submission_dispatches d SET status='MANUAL_INTERVENTION_REQUIRED',last_error='submission_receipt_reconciliation_required',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
 WHERE d.status='SUBMITTING' AND d.commit_started_at IS NOT NULL AND d.lease_expires_at<now();
 UPDATE tender.submission_dispatches d SET status='DEADLINE_EXPIRED',last_error='submission_deadline_expired',updated_at=now()
 WHERE (d.status IN('SUBMISSION_QUEUED','RETRY_REQUIRED','CREDENTIALS_REQUIRED') OR (d.status='SUBMITTING' AND d.lease_expires_at<now())) AND d.commit_started_at IS NULL AND d.deadline_at<=now();
 FOR candidate IN SELECT d.id,d.tenant_id,d.scope_key FROM tender.submission_dispatches d
  WHERE d.status IN('SUBMISSION_QUEUED','RETRY_REQUIRED','SUBMITTING') AND d.commit_started_at IS NULL AND d.next_attempt_at<=now() AND d.deadline_at>now() AND (d.lease_expires_at IS NULL OR d.lease_expires_at<now())
  ORDER BY d.deadline_at,d.created_at FOR UPDATE SKIP LOCKED LIMIT 20 LOOP
  key=hashtextextended('submission-dispatch:'||candidate.scope_key,0);
  IF NOT pg_try_advisory_lock(key) THEN CONTINUE; END IF;
  token=gen_random_uuid();
  UPDATE tender.submission_dispatches d SET lease_owner=worker,lease_token=token,lease_expires_at=now()+interval '90 seconds',attempt=attempt+1,updated_at=now() WHERE d.id=candidate.id;
  RETURN QUERY SELECT candidate.id,candidate.tenant_id,token,key; RETURN;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION tender.claim_submission_dispatch(text) FROM PUBLIC,tender_api_runtime;
GRANT EXECUTE ON FUNCTION tender.claim_submission_dispatch(text) TO tender_submission_worker_runtime;
REVOKE ALL ON FUNCTION tender.guard_submission_dispatch(),tender.audit_submission_dispatch(),tender.immutable_submission_evidence() FROM PUBLIC;

CREATE TABLE tender.submission_dispatch_operations(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,dispatch_id uuid NOT NULL,tenant_id uuid NOT NULL,event text NOT NULL CHECK(event IN('CREDENTIAL_RESOLVED','UPLOAD_VERIFIED','RECEIPT_RECONCILED')),
 evidence jsonb NOT NULL,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),previous_sha256 text NOT NULL,event_sha256 text NOT NULL,
 FOREIGN KEY(tenant_id,dispatch_id) REFERENCES tender.submission_dispatches(tenant_id,id)
);
ALTER TABLE tender.submission_dispatch_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender.submission_dispatch_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tender.submission_dispatch_operations USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
GRANT SELECT ON tender.submission_dispatch_operations TO tender_api_runtime;
CREATE TRIGGER immutable_submission_dispatch_operations BEFORE UPDATE OR DELETE ON tender.submission_dispatch_operations FOR EACH ROW EXECUTE FUNCTION tender.immutable_submission_evidence();
CREATE FUNCTION tender.record_submission_operation(dispatch uuid,token uuid,event_name text,safe_evidence jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d record; previous text; payload jsonb;
BEGIN
 SELECT * INTO d FROM tender.submission_dispatches WHERE id=dispatch FOR UPDATE;
 IF d.lease_token IS DISTINCT FROM token OR d.lease_expires_at<=clock_timestamp() OR d.status<>'SUBMITTING' THEN RAISE EXCEPTION 'submission_lease_lost'; END IF;
 IF (event_name='CREDENTIAL_RESOLVED' AND (safe_evidence - ARRAY['credentialId','revision'])<>'{}'::jsonb) OR (event_name='UPLOAD_VERIFIED' AND (safe_evidence - ARRAY['documentId','sha256','sizeBytes'])<>'{}'::jsonb) OR event_name NOT IN('CREDENTIAL_RESOLVED','UPLOAD_VERIFIED') THEN RAISE EXCEPTION 'submission_evidence_invalid'; END IF;
 SELECT event_sha256 INTO previous FROM tender.submission_dispatch_operations WHERE dispatch_id=dispatch ORDER BY id DESC LIMIT 1;
 previous=coalesce(previous,repeat('0',64));payload=jsonb_build_object('event',event_name,'evidence',safe_evidence,'bindingSha256',d.binding_sha256,'at',clock_timestamp());
 INSERT INTO tender.submission_dispatch_operations(dispatch_id,tenant_id,event,evidence,previous_sha256,event_sha256) VALUES(dispatch,d.tenant_id,event_name,payload,previous,encode(public.digest(previous||payload::text,'sha256'),'hex'));
END $$;
REVOKE ALL ON FUNCTION tender.record_submission_operation(uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tender.record_submission_operation(uuid,uuid,text,jsonb) TO tender_submission_worker_runtime;
CREATE FUNCTION tender.guard_submission_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE d record;
BEGIN
 SELECT * INTO d FROM tender.submission_dispatches WHERE id=NEW.dispatch_id;
 IF d.id IS NULL OR d.commit_started_at IS NULL OR d.tenant_id<>NEW.tenant_id OR d.binding_sha256<>NEW.binding_sha256 OR d.package_sha256<>NEW.package_sha256 OR NEW.documents IS DISTINCT FROM d.binding->'documents' OR NEW.submitted_at<d.released_at OR NEW.submitted_at>d.deadline_at OR NEW.submitted_at>clock_timestamp()+interval '5 seconds' THEN RAISE EXCEPTION 'submission_receipt_scope_mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_submission_receipt BEFORE INSERT ON tender.submission_dispatch_receipts FOR EACH ROW EXECUTE FUNCTION tender.guard_submission_receipt();
REVOKE ALL ON FUNCTION tender.guard_submission_receipt() FROM PUBLIC;
CREATE FUNCTION tender.claim_submission_notification() RETURNS TABLE(id uuid,dispatch_id uuid,state text,email text,token uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n record; new_token uuid;
BEGIN
 SELECT notification.*,u.email recipient_email INTO n FROM tender.submission_dispatch_notifications notification JOIN iam.users u ON u.id=notification.recipient_user_id AND u.active
 WHERE notification.delivery_status IN('PENDING','RETRY_REQUIRED','SENDING') AND notification.next_attempt_at<=now() AND (notification.lease_expires_at IS NULL OR notification.lease_expires_at<now()) ORDER BY notification.created_at FOR UPDATE OF notification SKIP LOCKED LIMIT 1;
 IF n.id IS NULL THEN RETURN; END IF;
 new_token=gen_random_uuid();
 UPDATE tender.submission_dispatch_notifications notification SET delivery_status='SENDING',attempts=attempts+1,lease_token=new_token,lease_expires_at=now()+interval '2 minutes' WHERE notification.id=n.id;
 RETURN QUERY SELECT n.id,n.dispatch_id,n.state,n.recipient_email::text,new_token;
END $$;
CREATE FUNCTION tender.finish_submission_notification(notification uuid,token uuid,success boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE tender.submission_dispatch_notifications SET delivery_status=CASE WHEN success THEN 'SENT' ELSE 'RETRY_REQUIRED' END,sent_at=CASE WHEN success THEN now() ELSE NULL END,next_attempt_at=now()+interval '5 minutes',lease_token=NULL,lease_expires_at=NULL WHERE id=notification AND lease_token=token;
END $$;
REVOKE ALL ON FUNCTION tender.claim_submission_notification(),tender.finish_submission_notification(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tender.claim_submission_notification(),tender.finish_submission_notification(uuid,uuid,boolean) TO tender_submission_worker_runtime;

CREATE FUNCTION tender.resume_submission_after_credential_readback(tenant uuid,company uuid,portal uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE changed integer; actor uuid;
BEGIN
 actor=nullif(current_setting('app.actor_user_id',true),'')::uuid;
 IF tenant IS DISTINCT FROM saas.current_tenant_id() OR NOT EXISTS(SELECT 1 FROM saas.tenant_memberships WHERE tenant_id=tenant AND user_id=actor AND status='ACTIVE' AND role IN('OWNER','ADMIN')) THEN RAISE EXCEPTION 'submission_scope_changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM tenant_portal.credential_vault c JOIN saas.audit_events a ON a.tenant_id=c.tenant_id AND a.target_id=c.id::text AND a.actor_user_id=actor AND a.action='PORTAL_CREDENTIAL_READBACK_VERIFIED' AND a.occurred_at>=now()-interval '1 minute' WHERE c.tenant_id=tenant AND c.company_id=company AND c.portal_id=portal) THEN RAISE EXCEPTION 'submission_credential_readback_required'; END IF;
 UPDATE tender.submission_dispatches SET status='SUBMISSION_QUEUED',last_error=NULL,next_attempt_at=now(),updated_at=now() WHERE tenant_id=tenant AND company_id=company AND portal_id=portal AND origin='TENANT_PORTAL' AND status='CREDENTIALS_REQUIRED' AND commit_started_at IS NULL AND deadline_at>clock_timestamp();
 GET DIAGNOSTICS changed=ROW_COUNT; RETURN changed;
END $$;
REVOKE ALL ON FUNCTION tender.resume_submission_after_credential_readback(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tender.resume_submission_after_credential_readback(uuid,uuid,uuid) TO tender_api_runtime;
CREATE FUNCTION tender.submission_monitor_snapshot() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'duplicateAttempts24h',(SELECT count(*) FROM tender.submission_duplicate_attempts WHERE occurred_at>now()-interval '24 hours'),
  'queued',(SELECT count(*) FROM tender.submission_dispatches WHERE status IN('SUBMISSION_QUEUED','RETRY_REQUIRED')),
  'urgentDeadlines',(SELECT count(*) FROM tender.submission_dispatches WHERE status<>'SUBMITTED' AND deadline_at BETWEEN now() AND now()+interval '30 minutes'),
  'portalErrors',(SELECT count(*) FROM tender.submission_dispatches WHERE status IN('PORTAL_CHANGED','MANUAL_INTERVENTION_REQUIRED','CREDENTIALS_REQUIRED')),
  'abandonedUploads',(SELECT count(*) FROM tender.submission_dispatches WHERE status='SUBMITTING' AND commit_started_at IS NULL AND lease_expires_at<now()),
  'missingReceipts',(SELECT count(*) FROM tender.submission_dispatches d WHERE commit_started_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tender.submission_dispatch_receipts r WHERE r.dispatch_id=d.id)),
  'pendingNotifications',(SELECT count(*) FROM tender.submission_dispatch_notifications WHERE delivery_status<>'SENT'),
  'staleWorkers',(SELECT count(*) FROM tender.submission_worker_heartbeats WHERE observed_at<now()-interval '60 seconds')
 );
$$;
REVOKE ALL ON FUNCTION tender.submission_monitor_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tender.submission_monitor_snapshot() TO tender_submission_worker_runtime;

CREATE TABLE tender.submission_credential_recoveries(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,company_id uuid NOT NULL,portal_id uuid NOT NULL REFERENCES tender.portal_registry(id),
 previous_credential_id uuid NOT NULL REFERENCES tender.portal_credential_secrets(id),new_credential_id uuid NOT NULL REFERENCES tender.portal_credential_secrets(id),actor_id uuid NOT NULL REFERENCES iam.users(id),occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,company_id,previous_credential_id),CHECK(previous_credential_id<>new_credential_id)
);
ALTER TABLE tender.submission_credential_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender.submission_credential_recoveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tender.submission_credential_recoveries USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
GRANT SELECT,INSERT ON tender.submission_credential_recoveries TO tender_api_runtime;
CREATE TRIGGER immutable_submission_credential_recoveries BEFORE UPDATE OR DELETE ON tender.submission_credential_recoveries FOR EACH ROW EXECUTE FUNCTION tender.immutable_submission_evidence();

COMMIT;
