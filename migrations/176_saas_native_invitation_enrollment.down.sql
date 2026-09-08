BEGIN;
SET LOCAL row_security=off;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM saas.invitation_enrollments) THEN RAISE EXCEPTION 'invitation_enrollments_not_empty_preserve_customer_data'; END IF; END $$;
DROP FUNCTION saas.accept_existing_native_invitation(uuid,text,uuid);
DROP FUNCTION saas.activate_invited_native_identity(uuid,uuid);
DROP FUNCTION saas.lock_usable_invitation(uuid,uuid);
DROP TABLE saas.invitation_enrollments;
DROP INDEX saas.tenant_invitation_enrollment_binding;
COMMIT;
