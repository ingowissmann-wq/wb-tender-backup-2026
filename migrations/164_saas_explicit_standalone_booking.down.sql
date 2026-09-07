BEGIN;
ALTER TABLE saas.subscriptions DROP COLUMN purchase_kind;
ALTER TABLE saas.checkout_sessions DROP COLUMN purchase_kind,DROP COLUMN booking_id,DROP COLUMN consent_version,DROP COLUMN consented_at,DROP COLUMN amount_subtotal,DROP COLUMN renewal;
ALTER TABLE saas.pending_registrations DROP COLUMN purchase_kind,DROP COLUMN booking_id,DROP COLUMN consent_version,DROP COLUMN consented_at;
CREATE OR REPLACE FUNCTION saas.provision_pending_native_identity(
  p_tenant_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas, iam
AS $$
DECLARE
  registration record;
  created_user_id uuid;
BEGIN
  SELECT pr.tenant_id,lower(pr.email) email,pr.password_hash,
         pr.mfa_secret_encrypted
  INTO registration
  FROM saas.pending_registrations pr
  JOIN saas.subscriptions s ON s.tenant_id=pr.tenant_id
  WHERE pr.tenant_id=p_tenant_id
    AND pr.email_verified_at IS NOT NULL
    AND pr.status='IAM_PROVISIONING_PENDING'
    AND pr.password_hash LIKE 'scrypt$%'
    AND length(pr.mfa_secret_encrypted)>=32
    AND s.status IN('TRIAL_ACTIVE','ACTIVE')
  FOR UPDATE OF pr;

  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT u.id INTO created_user_id
  FROM iam.users u WHERE lower(u.email)=registration.email FOR UPDATE;

  IF created_user_id IS NOT NULL THEN
    IF EXISTS(
      SELECT 1 FROM saas.tenant_memberships m
      WHERE m.user_id=created_user_id AND m.tenant_id<>p_tenant_id
        AND m.status='ACTIVE'
    ) THEN RETURN NULL; END IF;
    UPDATE iam.users
    SET password_hash=registration.password_hash,active=true,
        mfa_required=true,mfa_secret_encrypted=registration.mfa_secret_encrypted,
        mfa_last_counter=NULL,failed_attempts=0,locked_until=NULL
    WHERE id=created_user_id;
  ELSE
    INSERT INTO iam.users(
      email,password_hash,active,mfa_required,mfa_secret_encrypted,
      failed_attempts,mfa_last_counter
    ) VALUES(
      registration.email,registration.password_hash,true,true,
      registration.mfa_secret_encrypted,0,NULL
    ) RETURNING id INTO created_user_id;
  END IF;

  INSERT INTO saas.tenant_memberships(tenant_id,user_id,role,status)
  VALUES(p_tenant_id,created_user_id,'OWNER','ACTIVE')
  ON CONFLICT(tenant_id,user_id)
  DO UPDATE SET role='OWNER',status='ACTIVE';

  UPDATE saas.pending_registrations
  SET iam_provisioned_at=now(),status='ACTIVATED',
      password_hash=NULL,mfa_secret_encrypted=NULL,updated_at=now()
  WHERE tenant_id=p_tenant_id;

  INSERT INTO saas.audit_events(
    tenant_id,actor_user_id,action,target_type,target_id,metadata
  ) VALUES(
    p_tenant_id,created_user_id,'NATIVE_SELF_SERVICE_PROVISIONED',
    'iam_user',created_user_id::text,
    '{"mfa_required":true,"email_verified":true}'::jsonb
  );
  RETURN created_user_id;
END
$$;

REVOKE ALL ON FUNCTION saas.provision_pending_native_identity(uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION saas.provision_pending_native_identity(uuid)
  TO saas_runtime;

COMMIT;
