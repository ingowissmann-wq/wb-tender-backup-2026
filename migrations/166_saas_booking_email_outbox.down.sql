BEGIN;
DROP FUNCTION saas.enqueue_booking_confirmation(uuid,uuid);
DROP FUNCTION saas.claim_booking_email();
DROP FUNCTION saas.finish_booking_email(uuid,uuid,boolean);
DROP TABLE saas.booking_email_outbox;
COMMIT;
