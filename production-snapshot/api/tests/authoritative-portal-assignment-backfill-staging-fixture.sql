\set ON_ERROR_STOP on

INSERT INTO tender.portal_registry(id,display_name,canonical_domain,adapter_id,adapter_version,
  adapter_validation_status,adapter_enabled,capabilities)
VALUES('00000000-0000-4000-8000-000000001290','Context 129 Portal','context-129.example',
  'context-129','1.0.0','PRODUCTION_VALIDATED',true,
  ARRAY['TENDER_DOCUMENT_DOWNLOAD','BID_SUBMISSION']::text[]);

INSERT INTO tender.tender_deadline_evidence(id,tender_id,source_code,source_notice_id,lot_key,
  deadline_type,source_date,source_time,source_timezone,normalized_utc,europe_berlin,
  source_kind,parsing_status,decision_reason,evidence_sha256,raw_evidence)
VALUES('00000000-0000-4000-8000-000000001291','00000000-0000-4000-8000-000000001231',
  'DOE','CONTEXT-129-1','LOT-STAGING-1','TENDER_RECEIPT','2099-01-01','12:00',
  'Europe/Berlin','2099-01-01T11:00:00Z','01.01.2099 12:00 Europe/Berlin',
  'STRUCTURED_NOTICE','EXACT','ISOLATED_STAGING_FIXTURE',repeat('9',64),'{}'::jsonb);

INSERT INTO tender.tender_lot_selections(tenant_id,company_id,tender_id,tender_version_id,
  lot_id,source_lot_id,canonical_service,deadline_evidence_id,selection_source)
SELECT '00000000-0000-4000-8000-000000001250','00000000-0000-4000-8000-000000001252',
  '00000000-0000-4000-8000-000000001231','00000000-0000-4000-8000-000000001255',
  lot.id,'LOT-STAGING-1','security','00000000-0000-4000-8000-000000001291','EXPLICIT_SELECTION'
FROM tender.lots lot WHERE lot.tender_id='00000000-0000-4000-8000-000000001231'
  AND lot.external_id='LOT-STAGING-1';

INSERT INTO tender.tender_portal_resolutions(id,tender_id,tender_version_id,portal_id,exact_host,
  evidence_url,evidence_role,evidence_priority,resolution_status,evidence,evidence_sha256)
VALUES
('00000000-0000-4000-8000-000000001293','00000000-0000-4000-8000-000000001231',
  '00000000-0000-4000-8000-000000001255','00000000-0000-4000-8000-000000001290',
  'context-129.example','https://context-129.example/submission','SUBMISSION',100,
  'UNIQUE_EVIDENCE','{"fixture":true}'::jsonb,repeat('b',64));
