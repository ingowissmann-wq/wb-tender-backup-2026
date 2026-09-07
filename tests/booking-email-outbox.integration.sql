\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE tenant uuid:=gen_random_uuid(); booking uuid:=gen_random_uuid(); item saas.booking_email_outbox; lease uuid;
BEGIN
 INSERT INTO saas.tenants(id,status) VALUES(tenant,'ACTIVE');
 INSERT INTO saas.checkout_sessions(provider,provider_checkout_ref,tenant_id,plan_code,status,booking_id) VALUES('stripe','cs_synthetic_email',tenant,'NORMAL','PAYMENT_CONFIRMED',booking);
 INSERT INTO saas.booking_email_outbox(tenant_id,booking_id,recipient,payload) VALUES(tenant,booking,'synthetic@wb-test.invalid','{"purchaseKind":"PACKAGE"}');
 SELECT * INTO item FROM saas.claim_booking_email();
 IF item.booking_id IS DISTINCT FROM booking OR item.attempts<>1 OR item.state<>'SENDING' THEN RAISE EXCEPTION 'email_claim_invalid'; END IF;
 lease:=item.lease_token;
 IF saas.finish_booking_email(item.id,gen_random_uuid(),true) THEN RAISE EXCEPTION 'foreign_lease_accepted'; END IF;
 IF NOT saas.finish_booking_email(item.id,lease,false) THEN RAISE EXCEPTION 'email_retry_not_recorded'; END IF;
 SELECT * INTO item FROM saas.booking_email_outbox WHERE booking_id=booking;
 IF item.state<>'PENDING' OR item.next_attempt_at<=now() OR item.last_error_code<>'SMTP_DELIVERY_FAILED' THEN RAISE EXCEPTION 'email_backoff_missing'; END IF;
 UPDATE saas.booking_email_outbox SET next_attempt_at=now() WHERE booking_id=booking;
 SELECT * INTO item FROM saas.claim_booking_email();
 IF item.attempts<>2 THEN RAISE EXCEPTION 'email_retry_attempt_invalid'; END IF;
 IF NOT saas.finish_booking_email(item.id,item.lease_token,true) THEN RAISE EXCEPTION 'email_completion_failed'; END IF;
 IF EXISTS(SELECT 1 FROM saas.claim_booking_email() WHERE id IS NOT NULL) THEN RAISE EXCEPTION 'sent_email_reclaimed'; END IF;
 -- A crashed process leaves a lease; only an expired lease is reclaimable.
 UPDATE saas.booking_email_outbox SET state='SENDING',sent_at=NULL,lease_token=gen_random_uuid(),lease_until=now()+interval '1 minute' WHERE booking_id=booking;
 IF EXISTS(SELECT 1 FROM saas.claim_booking_email() WHERE id IS NOT NULL) THEN RAISE EXCEPTION 'live_lease_stolen'; END IF;
 UPDATE saas.booking_email_outbox SET lease_until=now()-interval '1 second' WHERE booking_id=booking;
 SELECT * INTO item FROM saas.claim_booking_email();
 IF item.booking_id IS DISTINCT FROM booking OR item.attempts<>3 THEN RAISE EXCEPTION 'crashed_dispatch_not_recovered'; END IF;
 UPDATE saas.booking_email_outbox SET attempts=10 WHERE booking_id=booking;
 IF NOT saas.finish_booking_email(item.id,item.lease_token,false) THEN RAISE EXCEPTION 'terminal_failure_not_recorded'; END IF;
 IF NOT EXISTS(SELECT 1 FROM saas.booking_email_outbox WHERE booking_id=booking AND state='FAILED') THEN RAISE EXCEPTION 'retry_limit_missing'; END IF;
 IF EXISTS(SELECT 1 FROM saas.claim_booking_email() WHERE id IS NOT NULL) THEN RAISE EXCEPTION 'failed_email_reclaimed'; END IF;
 IF has_table_privilege('tender_api_runtime','saas.booking_email_outbox','INSERT,UPDATE,DELETE,TRUNCATE') THEN RAISE EXCEPTION 'email_outbox_mutable_by_runtime'; END IF;
END $$;
ROLLBACK;
