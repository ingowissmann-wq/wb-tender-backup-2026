BEGIN;

CREATE TABLE saas.release_161_plan_snapshot(code text PRIMARY KEY,row_data jsonb NOT NULL);
REVOKE ALL ON saas.release_161_plan_snapshot FROM PUBLIC;
INSERT INTO saas.release_161_plan_snapshot
SELECT code,to_jsonb(p) FROM saas.plans p WHERE code IN('NORMAL','PROFESSIONAL','ENTERPRISE');
DO $$ BEGIN
  IF (SELECT count(*) FROM saas.release_161_plan_snapshot)<>3 THEN
    RAISE EXCEPTION 'migration_161_plan_snapshot_incomplete';
  END IF;
END $$;

UPDATE saas.plans
SET metadata = metadata || CASE code
  WHEN 'NORMAL' THEN '{"activation_fee_minor":29900,"setup_fee_minor":250000,"net_price":true}'::jsonb
  WHEN 'PROFESSIONAL' THEN '{"activation_fee_minor":29900,"setup_fee_minor":490000,"net_price":true}'::jsonb
  WHEN 'ENTERPRISE' THEN '{"activation_fee_minor":29900,"setup_fee_minor":990000,"net_price":true}'::jsonb
  ELSE '{}'::jsonb
END,
updated_at = now()
WHERE code IN ('NORMAL','PROFESSIONAL','ENTERPRISE');

CREATE OR REPLACE FUNCTION saas.provision_pending_oidc_identity(
  p_issuer text,
  p_subject text,
  p_email text
) RETURNS TABLE(user_id uuid, tenant_id uuid, email text, role text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas, iam
AS $$
DECLARE
  registration record;
  created_user_id uuid;
BEGIN
  IF p_issuer IS NULL OR p_subject IS NULL OR p_email IS NULL
     OR length(p_issuer) > 2048 OR length(p_subject) > 255 OR length(p_email) > 254 THEN
    RETURN;
  END IF;

  SELECT pr.tenant_id,lower(pr.email) AS email
  INTO registration
  FROM saas.pending_registrations pr
  JOIN saas.subscriptions s ON s.tenant_id=pr.tenant_id
  WHERE lower(pr.email)=lower(p_email)
    AND pr.email_verified_at IS NOT NULL
    AND pr.status='IAM_PROVISIONING_PENDING'
    AND s.status IN('TRIAL_ACTIVE','ACTIVE')
  FOR UPDATE OF pr;

  IF NOT FOUND OR EXISTS(SELECT 1 FROM iam.users u WHERE lower(u.email)=lower(p_email)) THEN
    RETURN;
  END IF;

  INSERT INTO iam.users(email,password_hash,active,mfa_required,failed_attempts,mfa_last_counter)
  VALUES(lower(p_email),'!oidc-only',true,true,0,NULL)
  RETURNING id INTO created_user_id;

  INSERT INTO saas.tenant_memberships(tenant_id,user_id,role,status)
  VALUES(registration.tenant_id,created_user_id,'OWNER','ACTIVE');

  INSERT INTO saas.iam_subject_bindings(issuer,subject,user_id,tenant_id,email,email_verified_at)
  VALUES(p_issuer,p_subject,created_user_id,registration.tenant_id,registration.email,now());

  UPDATE saas.pending_registrations
  SET iam_provisioned_at=now(),status='ACTIVATED',updated_at=now()
  WHERE tenant_id=registration.tenant_id;

  UPDATE saas.tenants SET status='ACTIVE',updated_at=now() WHERE id=registration.tenant_id;
  INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id,metadata)
  VALUES(registration.tenant_id,created_user_id,'OIDC_SELF_SERVICE_PROVISIONED','iam_user',created_user_id::text,'{"mfa_required":true,"email_verified":true}'::jsonb);

  RETURN QUERY SELECT created_user_id,registration.tenant_id,registration.email,'OWNER'::text;
END
$$;

REVOKE ALL ON FUNCTION saas.provision_pending_oidc_identity(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION saas.provision_pending_oidc_identity(text,text,text) TO saas_runtime;

COMMIT;
