BEGIN;
-- Legacy sessions have no explicit purchase kind and cannot activate access.
ALTER TABLE saas.pending_registrations
  ADD COLUMN purchase_kind text CHECK(purchase_kind IN('TRIAL','PACKAGE')),
  ADD COLUMN booking_id uuid,
  ADD COLUMN consent_version text,
  ADD COLUMN consented_at timestamptz;
ALTER TABLE saas.checkout_sessions
  ADD COLUMN purchase_kind text CHECK(purchase_kind IN('TRIAL','PACKAGE')),
  ADD COLUMN booking_id uuid UNIQUE,
  ADD COLUMN consent_version text,
  ADD COLUMN consented_at timestamptz,
  ADD COLUMN amount_subtotal bigint CHECK(amount_subtotal>0),
  ADD COLUMN renewal boolean NOT NULL DEFAULT false;
ALTER TABLE saas.subscriptions
  ADD COLUMN purchase_kind text CHECK(purchase_kind IN('TRIAL','PACKAGE'));
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
  IF saas.tenant_matches(p_tenant_id) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'tenant_context_required';
  END IF;
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

  -- Never replace credentials belonging to an existing identity.
  IF created_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'native_identity_already_exists';
  END IF;
  INSERT INTO iam.users(email,password_hash,active,mfa_required,mfa_secret_encrypted,failed_attempts,mfa_last_counter)
  VALUES(registration.email,registration.password_hash,true,true,registration.mfa_secret_encrypted,0,NULL)
  RETURNING id INTO created_user_id;

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
  TO saas_runtime,tender_api_runtime;


COMMIT;
