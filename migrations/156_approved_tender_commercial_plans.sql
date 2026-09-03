BEGIN;
-- Commercial values explicitly approved for this release. Existing stable
-- plan keys remain unchanged so subscriptions and audit history are preserved.
UPDATE saas.plans SET active=false,updated_at=now() WHERE code='CORE';
UPDATE saas.plans SET display_name='Pro',description='Tender discovery, analysis and document workflows',seat_limit=3,company_limit=1,recommended_monthly_price_minor=99000,price_status='APPROVED',active=true,metadata=metadata||'{"commercial_config_required":false,"net_price":true}'::jsonb,updated_at=now() WHERE code='NORMAL';
UPDATE saas.plans SET display_name='Business',description='Tender Autopilot and bid-package workflows',seat_limit=10,company_limit=3,recommended_monthly_price_minor=149000,price_status='APPROVED',active=true,metadata=metadata||'{"commercial_config_required":false,"net_price":true}'::jsonb,updated_at=now() WHERE code='PROFESSIONAL';
UPDATE saas.plans SET display_name='Enterprise',description='Extended governance, integrations and tenant limits',seat_limit=NULL,company_limit=NULL,recommended_monthly_price_minor=249000,price_status='APPROVED',active=true,metadata=metadata||'{"commercial_config_required":false,"custom_pricing":false,"net_price":true}'::jsonb,updated_at=now() WHERE code='ENTERPRISE';
COMMIT;
