BEGIN;
SET LOCAL lock_timeout='30s'; SET LOCAL statement_timeout='10min';
SELECT pg_advisory_xact_lock(hashtextextended('wb-tender:eu-etenders-family-adapters:150',0));
UPDATE tender.portal_registry SET adapter_id='unknown-1fb9978eb417',adapter_version='0.1.0',adapter_enabled=false,
 adapter_validation_status='NO_ACTIVE_TENDER_FOR_VALIDATION',portal_family_key='unknown-1fb9978eb417',updated_at=now()
WHERE id='7b624353-e099-4e6f-9a50-6a778e5ed892' AND adapter_id='eu-funding-tenders';
UPDATE tender.portal_registry SET adapter_id='unknown-238c4d9083f6',adapter_version='0.1.0',adapter_enabled=false,
 adapter_validation_status='NO_ACTIVE_TENDER_FOR_VALIDATION',portal_family_key='unknown-238c4d9083f6',updated_at=now()
WHERE id='003f1d5d-30ee-4b53-b020-9bec6c416ba5' AND adapter_id='etenders-ireland';
UPDATE tender.portal_connector_adapters SET enabled=false,validation_status='ADAPTER_REPAIR_REQUIRED',last_verified_at=now()
WHERE adapter_id IN('eu-funding-tenders','etenders-ireland') AND adapter_version='2.0.0';
UPDATE tender.portal_adapters SET kill_switch=true,last_error_code='ROLLED_BACK_TO_PRE150' WHERE portal_code IN('eu-funding-tenders','etenders-ireland');
DELETE FROM app.schema_migrations WHERE version='0150-eu-etenders-family-adapters';
INSERT INTO tender.audit_events(action,metadata) VALUES('EU_ETENDERS_FAMILY_ADAPTERS_ROLLED_BACK',jsonb_build_object(
 'release','20260826-eu-etenders-family-adapters-150.1','retainedEvidence',true,'physicalDeletes',0,
 'externalWrite',false,'externalSubmission',false,'transmitted',false));
COMMIT;
