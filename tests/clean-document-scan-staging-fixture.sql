\set ON_ERROR_STOP on

INSERT INTO tender.enrichment_versions(id,tender_id,version,source_code,notice_identifier,
  retrieved_at,source_url,payload_sha256,raw_payload,raw_content_type,structured_data,
  quality_summary,mapper_version,parser_version,historical)
VALUES('00000000-0000-4000-8000-000000001240','00000000-0000-4000-8000-000000001231',124,
  'STAGING','SCAN-124','2099-01-01T00:00:00Z','https://staging.invalid/scan-124',repeat('a',64),
  decode('00','hex'),'application/json','{}','{}','staging','staging',false);

INSERT INTO tender.enrichment_documents(id,enrichment_version_id,source_url,filename,fetch_status,
  mime_type,payload_sha256,content,provenance,resolution_status,document_class,
  procurement_relevant,tender_association_verified,lot_association_verified,
  magic_bytes_verified,content_size,procurement_verification_status)
VALUES
('00000000-0000-4000-8000-000000001241','00000000-0000-4000-8000-000000001240','https://staging.invalid/eligible.pdf','eligible.pdf','VORHANDEN','application/pdf',repeat('1',64),decode('25504446','hex'),'{"procurementVerified":true,"lotScope":"TENDER_GLOBAL"}','DOWNLOAD_SUCCEEDED','SPECIFICATION',true,true,true,true,4,'REVIEW_REQUIRED'),
('00000000-0000-4000-8000-000000001242','00000000-0000-4000-8000-000000001240','https://staging.invalid/parser.pdf','parser.pdf','PARSER_FEHLER','application/pdf',repeat('2',64),decode('25504446','hex'),'{"procurementVerified":true,"statusGuard":"FETCH_OR_PARSER_FAILURE"}','DOWNLOAD_SUCCEEDED','SPECIFICATION',true,true,true,true,4,'REVIEW_REQUIRED'),
('00000000-0000-4000-8000-000000001243','00000000-0000-4000-8000-000000001240','https://staging.invalid/lot.pdf','lot.pdf','VORHANDEN','application/pdf',repeat('3',64),decode('25504446','hex'),'{"procurementVerified":true,"lotScope":"LOT"}','DOWNLOAD_SUCCEEDED','LOT_DOCUMENTS',true,true,false,true,4,'REVIEW_REQUIRED'),
('00000000-0000-4000-8000-000000001244','00000000-0000-4000-8000-000000001240','https://staging.invalid/quarantine.pdf','quarantine.pdf','VORHANDEN','application/pdf',repeat('4',64),decode('25504446','hex'),'{"procurementVerified":true,"lotScope":"TENDER_GLOBAL"}','DOWNLOAD_SUCCEEDED','SPECIFICATION',true,true,true,true,4,'REVIEW_REQUIRED');

UPDATE tender.document_malware_scans
SET status=CASE payload_sha256 WHEN repeat('4',64) THEN 'QUARANTINED' ELSE 'CLEAN' END,
  detail_code=CASE payload_sha256 WHEN repeat('4',64) THEN 'scan_timeout' ELSE 'clean' END,
  scanned_at=now()
WHERE document_id IN(
  '00000000-0000-4000-8000-000000001241','00000000-0000-4000-8000-000000001242',
  '00000000-0000-4000-8000-000000001243','00000000-0000-4000-8000-000000001244'
);
