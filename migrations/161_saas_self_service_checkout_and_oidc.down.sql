BEGIN;
REVOKE ALL ON FUNCTION saas.provision_pending_oidc_identity(text,text,text) FROM saas_runtime;
DROP FUNCTION IF EXISTS saas.provision_pending_oidc_identity(text,text,text);
UPDATE saas.plans SET metadata=metadata-'activation_fee_minor'-'setup_fee_minor',updated_at=now() WHERE code IN('NORMAL','PROFESSIONAL','ENTERPRISE');
COMMIT;
