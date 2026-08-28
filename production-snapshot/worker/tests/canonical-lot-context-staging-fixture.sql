\set ON_ERROR_STOP on

INSERT INTO tender.sources(code,name,interface,base_url,enabled)
VALUES('STAGING','Context migration staging source','ISOLATED_FIXTURE','https://staging.invalid',false);

INSERT INTO tender.tenders(id,data_class,source_code,external_id,buyer,title,source_url,raw_sha256,
  source_lifecycle_status,participation_status,notice_classification)
VALUES('00000000-0000-4000-8000-000000001231','PUBLIC_REAL','STAGING','CONTEXT-123-1',
  'Staging buyer','Context continuity staging tender','https://staging.invalid/context-123-1',
  repeat('1',64),'ACTIVE','ELIGIBLE','COMPETITION');

INSERT INTO tender.tender_lot_lifecycles(tender_id,lot_key,lifecycle_status,participation_status,
  offer_deadline,deadline_quality,is_current)
VALUES('00000000-0000-4000-8000-000000001231','LOT-STAGING-1','ACTIVE','ELIGIBLE',
  '2099-01-01T12:00:00Z','EXACT',true);
