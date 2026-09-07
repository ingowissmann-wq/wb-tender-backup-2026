BEGIN;
CREATE TABLE saas.booking_email_outbox(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES saas.tenants(id),
 booking_id uuid NOT NULL UNIQUE REFERENCES saas.checkout_sessions(booking_id),
 recipient text NOT NULL,
 payload jsonb NOT NULL,
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN('PENDING','SENDING','SENT','FAILED')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid, lease_until timestamptz, sent_at timestamptz,
 last_error_code text, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE saas.booking_email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas.booking_email_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON saas.booking_email_outbox USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));
-- Only the migration owner, through narrowly granted dispatcher functions,
-- can claim across tenants; the runtime role sees only its bound tenant.
DO $$ BEGIN
 IF current_user IN('tender_api_runtime','wb_tender_api_login') THEN RAISE EXCEPTION 'separate_migration_owner_required'; END IF;
 EXECUTE format('CREATE POLICY dispatcher_owner ON saas.booking_email_outbox TO %I USING(true) WITH CHECK(true)',current_user);
END $$;
REVOKE ALL ON saas.booking_email_outbox FROM PUBLIC,tender_api_runtime,wb_tender_api_login;
GRANT SELECT ON saas.booking_email_outbox TO tender_api_runtime;
CREATE INDEX booking_email_dispatch_queue ON saas.booking_email_outbox(next_attempt_at,created_at) WHERE state IN('PENDING','SENDING');

CREATE FUNCTION saas.enqueue_booking_confirmation(candidate uuid,booking uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas AS $$
BEGIN
 IF saas.tenant_matches(candidate) IS DISTINCT FROM true THEN RAISE EXCEPTION 'tenant_context_required'; END IF;
 INSERT INTO saas.booking_email_outbox(tenant_id,booking_id,recipient,payload)
 SELECT c.tenant_id,c.booking_id,r.email,jsonb_build_object(
   'purchaseKind',c.purchase_kind,'planName',CASE WHEN c.purchase_kind='TRIAL' THEN '14 Tage Komplettzugang' ELSE p.display_name END,
   'amountSubtotal',c.amount_subtotal,'billingPath',c.billing_path,'renewal',c.renewal,
   'periodEnd',CASE WHEN c.purchase_kind='TRIAL' THEN s.trial_ends_at ELSE s.current_period_ends_at END)
 FROM saas.checkout_sessions c
 JOIN saas.pending_registrations r ON r.tenant_id=c.tenant_id
 JOIN saas.subscriptions s ON s.tenant_id=c.tenant_id
 JOIN saas.plans p ON p.code=c.plan_code
 WHERE c.tenant_id=candidate AND c.booking_id=booking AND c.status='PAYMENT_CONFIRMED'
   AND r.email_verified_at IS NOT NULL AND r.iam_provisioned_at IS NOT NULL
   AND s.status IN('ACTIVE','TRIAL_ACTIVE')
 ON CONFLICT(booking_id) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM saas.booking_email_outbox WHERE tenant_id=candidate AND booking_id=booking) THEN
  RAISE EXCEPTION 'booking_confirmation_prerequisites_missing';
 END IF;
END $$;

CREATE FUNCTION saas.claim_booking_email() RETURNS saas.booking_email_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas AS $$
DECLARE item saas.booking_email_outbox;
BEGIN
 SELECT * INTO item FROM saas.booking_email_outbox
 WHERE (state='PENDING' AND next_attempt_at<=now()) OR (state='SENDING' AND lease_until<now())
 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE saas.booking_email_outbox SET state='SENDING',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes'
 WHERE id=item.id RETURNING * INTO item;
 RETURN item;
END $$;

CREATE FUNCTION saas.finish_booking_email(candidate uuid,lease uuid,succeeded boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas AS $$
BEGIN
 UPDATE saas.booking_email_outbox SET
  state=CASE WHEN succeeded THEN 'SENT' WHEN attempts>=10 THEN 'FAILED' ELSE 'PENDING' END,
  sent_at=CASE WHEN succeeded THEN now() ELSE NULL END,
  last_error_code=CASE WHEN succeeded THEN NULL ELSE 'SMTP_DELIVERY_FAILED' END,
  next_attempt_at=now()+make_interval(secs=>least(3600,30*power(2,least(attempts,7)))),
  lease_token=NULL,lease_until=NULL
 WHERE id=candidate AND lease_token=lease AND state='SENDING';
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION saas.enqueue_booking_confirmation(uuid,uuid),saas.claim_booking_email(),saas.finish_booking_email(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION saas.enqueue_booking_confirmation(uuid,uuid),saas.claim_booking_email(),saas.finish_booking_email(uuid,uuid,boolean) TO tender_api_runtime;
COMMIT;
