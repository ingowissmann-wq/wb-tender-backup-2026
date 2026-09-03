BEGIN;
UPDATE saas.plans SET active=true WHERE code='CORE';
UPDATE saas.plans SET display_name='Normal',recommended_monthly_price_minor=NULL,price_status='PLACEHOLDER',metadata=metadata||'{"commercial_config_required":true}'::jsonb WHERE code='NORMAL';
UPDATE saas.plans SET display_name='Professional',recommended_monthly_price_minor=NULL,price_status='PLACEHOLDER',metadata=metadata||'{"commercial_config_required":true}'::jsonb WHERE code='PROFESSIONAL';
UPDATE saas.plans SET recommended_monthly_price_minor=NULL,price_status='PLACEHOLDER',metadata=metadata||'{"commercial_config_required":true,"custom_pricing":true}'::jsonb WHERE code='ENTERPRISE';
COMMIT;
