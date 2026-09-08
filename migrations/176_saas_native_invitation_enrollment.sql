BEGIN;
CREATE UNIQUE INDEX tenant_invitation_enrollment_binding ON saas.tenant_invitations(tenant_id,id);
CREATE TABLE saas.invitation_enrollments(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,invitation_id uuid NOT NULL,email text NOT NULL,
 nonce_hash char(64) NOT NULL CHECK(nonce_hash ~ '^[0-9a-f]{64}$'),
 password_hash text,mfa_secret_encrypted text,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','VERIFIED','ACTIVATED')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 8),
 expires_at timestamptz NOT NULL,verified_at timestamptz,accepted_user_id uuid REFERENCES iam.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,invitation_id),UNIQUE(tenant_id,nonce_hash),
 FOREIGN KEY(tenant_id,invitation_id) REFERENCES saas.tenant_invitations(tenant_id,id),
 CHECK(status='ACTIVATED' OR (password_hash IS NOT NULL AND password_hash LIKE 'scrypt$%' AND mfa_secret_encrypted IS NOT NULL AND length(mfa_secret_encrypted)>=32)),
 CHECK(status<>'ACTIVATED' OR (password_hash IS NULL AND mfa_secret_encrypted IS NULL AND accepted_user_id IS NOT NULL AND verified_at IS NOT NULL)),
 CHECK(status<>'VERIFIED' OR verified_at IS NOT NULL)
);
ALTER TABLE saas.invitation_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.invitation_enrollments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON saas.invitation_enrollments USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
REVOKE ALL ON saas.invitation_enrollments FROM PUBLIC,saas_runtime,tender_api_runtime,wb_tender_api_login;
GRANT SELECT,INSERT,UPDATE ON saas.invitation_enrollments TO tender_api_runtime;

-- Deliberately private helper. Global checks must not silently inherit the
-- target-tenant RLS view; row_security=off fails closed for an unsafe owner.
CREATE FUNCTION saas.lock_usable_invitation(p_tenant_id uuid,p_invitation_id uuid) RETURNS saas.tenant_invitations
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=off AS $$
DECLARE invitation saas.tenant_invitations%ROWTYPE;
BEGIN
 IF saas.tenant_matches(p_tenant_id) IS DISTINCT FROM true THEN RAISE EXCEPTION 'tenant_context_required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('saas-plan:'||p_tenant_id::text,0));
 SELECT * INTO invitation FROM saas.tenant_invitations WHERE tenant_id=p_tenant_id AND id=p_invitation_id FOR UPDATE;
 IF NOT FOUND OR invitation.status<>'PENDING' OR invitation.expires_at<=now() THEN RAISE EXCEPTION 'invitation_not_eligible'; END IF;
 IF NOT EXISTS(SELECT 1 FROM saas.tenant_memberships WHERE tenant_id=p_tenant_id AND user_id=invitation.invited_by AND role IN('OWNER','ADMIN') AND status='ACTIVE') THEN RAISE EXCEPTION 'invitation_issuer_inactive'; END IF;
 IF NOT EXISTS(SELECT 1 FROM saas.tenants t JOIN saas.subscriptions s ON s.tenant_id=t.id WHERE t.id=p_tenant_id AND t.status='ACTIVE' AND ((s.status='TRIAL_ACTIVE' AND s.trial_ends_at>now()) OR (s.status='ACTIVE' AND (s.current_period_ends_at IS NULL OR s.current_period_ends_at>now())))) THEN RAISE EXCEPTION 'invitation_tenant_inactive'; END IF;
 RETURN invitation;
END $$;
REVOKE ALL ON FUNCTION saas.lock_usable_invitation(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION saas.activate_invited_native_identity(p_tenant_id uuid,p_enrollment_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=off AS $$
DECLARE enrollment saas.invitation_enrollments%ROWTYPE; invitation saas.tenant_invitations%ROWTYPE; created_user uuid;
BEGIN
 IF saas.tenant_matches(p_tenant_id) IS DISTINCT FROM true THEN RAISE EXCEPTION 'tenant_context_required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('saas-plan:'||p_tenant_id::text,0));
 SELECT * INTO enrollment FROM saas.invitation_enrollments WHERE tenant_id=p_tenant_id AND id=p_enrollment_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'invitation_enrollment_invalid'; END IF;
 IF enrollment.status='ACTIVATED' THEN RETURN enrollment.accepted_user_id; END IF;
 IF enrollment.status<>'VERIFIED' OR enrollment.verified_at IS NULL OR enrollment.expires_at<=now() THEN RAISE EXCEPTION 'invitation_mfa_required'; END IF;
 invitation:=saas.lock_usable_invitation(p_tenant_id,enrollment.invitation_id);
 IF lower(enrollment.email)<>lower(invitation.email) THEN RAISE EXCEPTION 'invitation_email_mismatch'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('native-email:'||lower(enrollment.email),0));
 IF EXISTS(SELECT 1 FROM iam.users WHERE lower(email)=lower(enrollment.email)) THEN RAISE EXCEPTION 'native_identity_already_exists'; END IF;
 IF EXISTS(SELECT 1 FROM saas.pending_registrations WHERE lower(email)=lower(enrollment.email)) THEN RAISE EXCEPTION 'self_service_registration_already_pending'; END IF;
 INSERT INTO iam.users(email,password_hash,active,mfa_required,mfa_secret_encrypted,failed_attempts,mfa_last_counter)
 VALUES(lower(enrollment.email),enrollment.password_hash,true,true,enrollment.mfa_secret_encrypted,0,NULL) RETURNING id INTO created_user;
 -- The existing serialized membership trigger enforces the actual seat limit.
 INSERT INTO saas.tenant_memberships(tenant_id,user_id,role,status) VALUES(p_tenant_id,created_user,invitation.role,'ACTIVE');
 UPDATE saas.tenant_invitations SET status='ACCEPTED',accepted_user_id=created_user,updated_at=now() WHERE id=invitation.id;
 UPDATE saas.invitation_enrollments SET status='ACTIVATED',accepted_user_id=created_user,password_hash=NULL,mfa_secret_encrypted=NULL,updated_at=now() WHERE id=enrollment.id;
 INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id,metadata) VALUES(p_tenant_id,created_user,'INVITED_NATIVE_IDENTITY_ACTIVATED','tenant_invitation',invitation.id::text,jsonb_build_object('role',invitation.role,'email_verified',true,'mfa_verified',true));
 RETURN created_user;
END $$;
REVOKE ALL ON FUNCTION saas.activate_invited_native_identity(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION saas.activate_invited_native_identity(uuid,uuid) TO tender_api_runtime;

CREATE FUNCTION saas.accept_existing_native_invitation(p_tenant_id uuid,p_token_hash text,p_user_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=off AS $$
DECLARE invitation saas.tenant_invitations%ROWTYPE; identity_row record; existing_role text;
BEGIN
 IF saas.tenant_matches(p_tenant_id) IS DISTINCT FROM true OR nullif(current_setting('app.actor_user_id',true),'')::uuid IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'tenant_context_required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('saas-plan:'||p_tenant_id::text,0));
 SELECT * INTO invitation FROM saas.tenant_invitations WHERE tenant_id=p_tenant_id AND token_hash=p_token_hash FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'invitation_not_eligible'; END IF;
 SELECT id,email,active,mfa_required,mfa_secret_encrypted INTO identity_row FROM iam.users WHERE id=p_user_id;
 IF NOT FOUND OR NOT identity_row.active OR NOT identity_row.mfa_required OR identity_row.mfa_secret_encrypted IS NULL OR lower(identity_row.email)<>lower(invitation.email) THEN RAISE EXCEPTION 'invitation_not_eligible'; END IF;
 IF EXISTS(SELECT 1 FROM saas.tenant_memberships WHERE user_id=p_user_id AND tenant_id<>p_tenant_id AND status='ACTIVE') THEN RAISE EXCEPTION 'multi_tenant_identity_not_enabled'; END IF;
 SELECT role INTO existing_role FROM saas.tenant_memberships WHERE tenant_id=p_tenant_id AND user_id=p_user_id AND status='ACTIVE';
 IF invitation.status='ACCEPTED' AND invitation.accepted_user_id=p_user_id AND existing_role IS NOT NULL THEN RETURN existing_role; END IF;
 invitation:=saas.lock_usable_invitation(p_tenant_id,invitation.id);
 IF EXISTS(SELECT 1 FROM saas.tenant_memberships WHERE tenant_id=p_tenant_id AND user_id=p_user_id) THEN RAISE EXCEPTION 'membership_already_exists'; END IF;
 INSERT INTO saas.tenant_memberships(tenant_id,user_id,role,status) VALUES(p_tenant_id,p_user_id,invitation.role,'ACTIVE');
 UPDATE saas.tenant_invitations SET status='ACCEPTED',accepted_user_id=p_user_id,updated_at=now() WHERE id=invitation.id;
 INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id,metadata) VALUES(p_tenant_id,p_user_id,'MEMBERSHIP_ACCEPTED','tenant_invitation',invitation.id::text,jsonb_build_object('role',invitation.role,'existing_credentials_preserved',true));
 RETURN invitation.role;
END $$;
REVOKE ALL ON FUNCTION saas.accept_existing_native_invitation(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION saas.accept_existing_native_invitation(uuid,text,uuid) TO tender_api_runtime;
COMMIT;
