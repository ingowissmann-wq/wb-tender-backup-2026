BEGIN;
ALTER TABLE saas.subscriptions DROP COLUMN IF EXISTS billing_collection;
ALTER TABLE saas.checkout_sessions DROP COLUMN IF EXISTS billing_path;
ALTER TABLE saas.pending_registrations DROP COLUMN IF EXISTS billing_path;
COMMIT;
