BEGIN;
REVOKE ALL ON FUNCTION saas.provision_pending_native_identity(uuid)
  FROM saas_runtime;
DROP FUNCTION IF EXISTS saas.provision_pending_native_identity(uuid);
ALTER TABLE saas.pending_registrations
  DROP COLUMN IF EXISTS mfa_secret_encrypted,
  DROP COLUMN IF EXISTS password_hash;
COMMIT;
