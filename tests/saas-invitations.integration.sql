\set ON_ERROR_STOP on
BEGIN;
-- Isolated fixture only; all identities and invitations are rolled back.
DO $$
DECLARE tenant uuid:=gen_random_uuid(); other uuid:=gen_random_uuid(); owner_id uuid:=gen_random_uuid();
 invited uuid; enrollment uuid; created_user uuid; outsider uuid:=gen_random_uuid(); original_password text:='scrypt$unchanged'; existing_user uuid:=gen_random_uuid();
BEGIN
 INSERT INTO saas.tenants(id,status) VALUES(tenant,'ACTIVE'),(other,'ACTIVE');
 INSERT INTO saas.subscriptions(tenant_id,status,plan_code,current_period_ends_at) VALUES(tenant,'ACTIVE','NORMAL',now()+interval '1 month'),(other,'ACTIVE','ENTERPRISE',now()+interval '1 month');
 INSERT INTO iam.users(id,email,active,mfa_required,password_hash,mfa_secret_encrypted) VALUES(owner_id,'owner@invitation.invalid',true,true,original_password,repeat('e',40)),(outsider,'foreign@invitation.invalid',true,true,original_password,repeat('e',40));
 PERFORM set_config('app.tenant_id',other::text,true);
 INSERT INTO saas.tenant_memberships(tenant_id,user_id,role,status) VALUES(other,outsider,'OWNER','ACTIVE');
 PERFORM set_config('app.tenant_id',tenant::text,true);
 INSERT INTO saas.tenant_memberships(tenant_id,user_id,role,status) VALUES(tenant,owner_id,'OWNER','ACTIVE');
 INSERT INTO saas.tenant_invitations(tenant_id,email,role,token_hash,expires_at,invited_by) VALUES(tenant,'new@invitation.invalid','MEMBER',repeat('a',64),now()+interval '1 hour',owner_id) RETURNING id INTO invited;
 INSERT INTO saas.invitation_enrollments(id,tenant_id,invitation_id,email,nonce_hash,password_hash,mfa_secret_encrypted,expires_at) VALUES(gen_random_uuid(),tenant,invited,'new@invitation.invalid',repeat('b',64),'scrypt$new',repeat('e',40),now()+interval '15 minutes') RETURNING id INTO enrollment;
 BEGIN PERFORM saas.activate_invited_native_identity(tenant,enrollment);RAISE EXCEPTION 'unverified_accepted';EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'invitation_mfa_required' THEN RAISE;END IF;END;
 UPDATE saas.invitation_enrollments SET status='VERIFIED',verified_at=now() WHERE id=enrollment;
 UPDATE saas.subscriptions SET status='PENDING_PAYMENT' WHERE tenant_id=tenant;
 BEGIN PERFORM saas.activate_invited_native_identity(tenant,enrollment);RAISE EXCEPTION 'unpaid_accepted';EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'invitation_tenant_inactive' THEN RAISE;END IF;END;
 UPDATE saas.subscriptions SET status='ACTIVE' WHERE tenant_id=tenant;
 created_user:=saas.activate_invited_native_identity(tenant,enrollment);
 IF saas.activate_invited_native_identity(tenant,enrollment)<>created_user THEN RAISE EXCEPTION 'activation_not_idempotent';END IF;
 IF NOT EXISTS(SELECT 1 FROM iam.users WHERE id=created_user AND active AND mfa_required AND password_hash='scrypt$new') THEN RAISE EXCEPTION 'native_identity_invalid';END IF;
 IF EXISTS(SELECT 1 FROM saas.invitation_enrollments WHERE id=enrollment AND (password_hash IS NOT NULL OR mfa_secret_encrypted IS NOT NULL)) THEN RAISE EXCEPTION 'pending_credentials_not_cleared';END IF;
 IF (SELECT count(*) FROM saas.audit_events WHERE tenant_id=tenant AND action='INVITED_NATIVE_IDENTITY_ACTIVATED')<>1 THEN RAISE EXCEPTION 'duplicate_activation_audit';END IF;
 INSERT INTO saas.tenant_invitations(tenant_id,email,role,token_hash,expires_at,invited_by) VALUES(tenant,'foreign@invitation.invalid','MEMBER',repeat('c',64),now()+interval '1 hour',owner_id);
 PERFORM set_config('app.actor_user_id',outsider::text,true);
 -- Execute as the RLS-bound runtime: the function must still see the foreign membership.
 EXECUTE 'SET LOCAL ROLE wb_tender_api_login';
 BEGIN PERFORM saas.accept_existing_native_invitation(tenant,repeat('c',64),outsider);RAISE EXCEPTION 'foreign_membership_accepted';EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'multi_tenant_identity_not_enabled' THEN RAISE;END IF;END;
 EXECUTE 'RESET ROLE';
 INSERT INTO saas.tenant_invitations(tenant_id,email,role,token_hash,expires_at,invited_by) VALUES(tenant,'owner@invitation.invalid','MEMBER',repeat('d',64),now()+interval '1 hour',owner_id);
 PERFORM set_config('app.actor_user_id',owner_id::text,true);
 BEGIN PERFORM saas.accept_existing_native_invitation(tenant,repeat('d',64),owner_id);RAISE EXCEPTION 'owner_demoted';EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'membership_already_exists' THEN RAISE;END IF;END;
 IF (SELECT password_hash FROM iam.users WHERE id=owner_id)<>original_password OR (SELECT role FROM saas.tenant_memberships WHERE tenant_id=tenant AND user_id=owner_id)<>'OWNER' THEN RAISE EXCEPTION 'existing_identity_modified';END IF;
 INSERT INTO iam.users(id,email,active,mfa_required,password_hash,mfa_secret_encrypted) VALUES(existing_user,'existing@invitation.invalid',true,true,original_password,repeat('e',40));
 INSERT INTO saas.tenant_invitations(tenant_id,email,role,token_hash,expires_at,invited_by) VALUES(tenant,'existing@invitation.invalid','BILLING',repeat('1',64),now()+interval '1 hour',owner_id);
 PERFORM set_config('app.actor_user_id',existing_user::text,true);
 EXECUTE 'SET LOCAL ROLE wb_tender_api_login';
 IF saas.accept_existing_native_invitation(tenant,repeat('1',64),existing_user)<>'BILLING' OR saas.accept_existing_native_invitation(tenant,repeat('1',64),existing_user)<>'BILLING' THEN RAISE EXCEPTION 'existing_identity_acceptance_failed';END IF;
 EXECUTE 'RESET ROLE';
 IF (SELECT password_hash FROM iam.users WHERE id=existing_user)<>original_password THEN RAISE EXCEPTION 'existing_password_replaced';END IF;

 INSERT INTO saas.tenant_invitations(tenant_id,email,role,token_hash,expires_at,invited_by) VALUES(tenant,'overflow@invitation.invalid','MEMBER',repeat('e',64),now()+interval '1 hour',owner_id) RETURNING id INTO invited;
 INSERT INTO saas.invitation_enrollments(id,tenant_id,invitation_id,email,nonce_hash,password_hash,mfa_secret_encrypted,expires_at,status,verified_at) VALUES(gen_random_uuid(),tenant,invited,'overflow@invitation.invalid',repeat('f',64),'scrypt$new',repeat('e',40),now()+interval '15 minutes','VERIFIED',now()) RETURNING id INTO enrollment;
 BEGIN PERFORM saas.activate_invited_native_identity(tenant,enrollment);RAISE EXCEPTION 'seat_overflow_accepted';EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'saas_plan_limit_exceeded' THEN RAISE;END IF;END;
 IF EXISTS(SELECT 1 FROM iam.users WHERE email='overflow@invitation.invalid') THEN RAISE EXCEPTION 'failed_activation_identity_leaked';END IF;
END $$;
ROLLBACK;
