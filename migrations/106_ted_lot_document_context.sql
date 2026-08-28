BEGIN;

CREATE TABLE IF NOT EXISTS tender.tender_external_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tender.tenders(id),
  tender_version_id uuid NOT NULL REFERENCES tender.tender_versions(id),
  source_lot_id text,
  role text NOT NULL CHECK (role IN ('NOTICE','NOTICE_VIEW','PUBLIC_DOCUMENT','PROCUREMENT_DOCUMENT','BUYER_COMMUNICATION','REGISTRATION','LOGIN','SUBMISSION','UNKNOWN_REVIEW_REQUIRED')),
  original_url text NOT NULL CHECK (original_url ~ '^https://'),
  final_url text CHECK (final_url IS NULL OR final_url ~ '^https://'),
  original_host text NOT NULL,
  final_host text,
  public_access boolean NOT NULL DEFAULT false,
  verification_status text NOT NULL DEFAULT 'DISCOVERED' CHECK (verification_status IN ('DISCOVERED','HTTP_VERIFIED','LOGIN_REQUIRED','MFA_REQUIRED','REVIEW_REQUIRED','FAILED_RETRYABLE','FAILED_FINAL')),
  http_status integer,
  content_type text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_sha256 character(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT(tender_version_id,source_lot_id,role,original_url)
);

CREATE INDEX IF NOT EXISTS tender_external_links_tender_role_idx ON tender.tender_external_links(tender_id,role,created_at DESC);

CREATE TABLE IF NOT EXISTS tender.tender_lot_selections (
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  tender_id uuid NOT NULL REFERENCES tender.tenders(id),
  tender_version_id uuid NOT NULL REFERENCES tender.tender_versions(id),
  lot_id uuid NOT NULL REFERENCES tender.lots(id),
  source_lot_id text NOT NULL,
  inbox_id uuid REFERENCES tender.management_inbox(id),
  region_evaluation_id uuid REFERENCES tender.region_evaluations(id),
  canonical_service text NOT NULL,
  deadline_evidence_id uuid NOT NULL REFERENCES tender.tender_deadline_evidence(id),
  selection_source text NOT NULL CHECK (selection_source IN ('SINGLE_ELIGIBLE_LOT','EXPLICIT_SELECTION','BOUNDED_BACKFILL')),
  selected_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,company_id,tender_id),
  UNIQUE(tenant_id,company_id,tender_id,lot_id)
);

CREATE TABLE IF NOT EXISTS tender.enrichment_context_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrichment_version_id uuid NOT NULL REFERENCES tender.enrichment_versions(id),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  tender_id uuid NOT NULL REFERENCES tender.tenders(id),
  tender_version_id uuid NOT NULL REFERENCES tender.tender_versions(id),
  lot_id uuid NOT NULL REFERENCES tender.lots(id),
  source_lot_id text NOT NULL,
  canonical_service text NOT NULL,
  source_manifest_sha256 character(64) NOT NULL CHECK (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,company_id,tender_version_id,lot_id,source_manifest_sha256),
  UNIQUE(enrichment_version_id,tenant_id,company_id,lot_id)
);

-- Bounded, evidence-based repair for TED notice 547290-2026 only.
WITH target AS (
  SELECT t.id tender_id,v.id tender_version_id,t.source_url,t.external_id,v.source_sha256
  FROM tender.tenders t
  JOIN LATERAL (SELECT id,source_sha256 FROM tender.tender_versions WHERE tender_id=t.id ORDER BY version DESC LIMIT 1) v ON true
  WHERE t.source_code='TED' AND t.external_id='547290-2026'
), source AS (
  INSERT INTO tender.source_references(tender_id,tender_version_id,source_code,source_url,source_identifier,retrieved_at,sha256,metadata)
  SELECT tender_id,tender_version_id,'TED','https://ted.europa.eu/de/notice/547290-2026/xml','547290-2026',now(),source_sha256,
    jsonb_build_object('role','NOTICE','format','XML','officialDirectLink',true,'boundedRepair','106_ted_lot_document_context')
  FROM target
  WHERE NOT EXISTS (SELECT 1 FROM tender.source_references r WHERE r.tender_version_id=target.tender_version_id AND r.source_url='https://ted.europa.eu/de/notice/547290-2026/xml')
  RETURNING id,tender_id
), source_id AS (
  SELECT id,tender_id FROM source UNION ALL
  SELECT r.id,r.tender_id FROM tender.source_references r JOIN target t ON t.tender_version_id=r.tender_version_id
  WHERE r.source_url='https://ted.europa.eu/de/notice/547290-2026/xml' LIMIT 1
)
INSERT INTO tender.lots(tender_id,external_id,title,description,locations,cpv_codes,deadline,source_reference_id)
SELECT life.tender_id,life.lot_key,'Wachdienstleistungen in den Inobhutnahmeeinrichtungen des Jugendamtes',
  'Offiziell im TED-eForms-XML ausgewiesenes Los',jsonb_build_array(jsonb_build_object('nuts','DE111','city','Stuttgart')),ARRAY['79713000'],life.offer_deadline,source_id.id
FROM tender.tender_lot_lifecycles life JOIN source_id ON source_id.tender_id=life.tender_id
WHERE life.lot_key='LOT-0000' AND life.is_current AND life.deadline_quality='EXACT'
ON CONFLICT (tender_id,external_id) WHERE external_id IS NOT NULL DO NOTHING;

WITH target AS (
  SELECT t.id tender_id,v.id tender_version_id
  FROM tender.tenders t JOIN LATERAL(SELECT id FROM tender.tender_versions WHERE tender_id=t.id ORDER BY version DESC LIMIT 1)v ON true
  WHERE t.source_code='TED' AND t.external_id='547290-2026'
), links(role,url,public_access,status,content_type,evidence) AS (VALUES
  ('NOTICE','https://ted.europa.eu/de/notice/547290-2026/xml',true,'HTTP_VERIFIED','application/xml','{"format":"XML","official":true}'::jsonb),
  ('PUBLIC_DOCUMENT','https://ted.europa.eu/de/notice/547290-2026/pdf',true,'HTTP_VERIFIED','application/pdf','{"format":"PDF","official":true}'::jsonb),
  ('NOTICE','https://ted.europa.eu/de/notice/547290-2026/html',true,'DISCOVERED','text/html','{"format":"HTML","official":true}'::jsonb),
  ('NOTICE_VIEW','https://ted.europa.eu/de/notice/-/detail/547290-2026',true,'DISCOVERED','text/html','{"format":"HTML_VIEW","official":true}'::jsonb),
  ('PROCUREMENT_DOCUMENT','https://lhs-vpbw.vmstart.de/NetServer/TenderingProcedureDetails?function=_Details&TenderOID=54321-Tender-19efee0f6ce-1876df401169f670',true,'HTTP_VERIFIED','text/html','{"xmlPath":"CallForTendersDocumentReference","official":true,"redirectChecked":true}'::jsonb),
  ('LOGIN','https://ted.europa.eu/en/login',false,'HTTP_VERIFIED','text/html','{"accountScope":"TED_ACCOUNT","submissionPortal":false}'::jsonb),
  ('REGISTRATION','https://ecas.ec.europa.eu/cas/eim/external/register.cgi',false,'HTTP_VERIFIED','text/html','{"accountScope":"TED_ACCOUNT","submissionPortal":false}'::jsonb)
)
INSERT INTO tender.tender_external_links(tender_id,tender_version_id,source_lot_id,role,original_url,final_url,original_host,final_host,public_access,verification_status,http_status,content_type,evidence,evidence_sha256,verified_at)
SELECT target.tender_id,target.tender_version_id,'LOT-0000',links.role,links.url,links.url,
  split_part(split_part(links.url,'://',2),'/',1),split_part(split_part(links.url,'://',2),'/',1),links.public_access,links.status,200,links.content_type,
  links.evidence,encode(digest(links.evidence::text,'sha256'),'hex'),CASE WHEN links.status='HTTP_VERIFIED' THEN now() ELSE NULL END
FROM target CROSS JOIN links
ON CONFLICT(tender_version_id,source_lot_id,role,original_url) DO NOTHING;

UPDATE tender.portal_registry SET
  authentication_entry_url=coalesce(authentication_entry_url,'https://ted.europa.eu/en/login'),
  registration_entry_url=coalesce(registration_entry_url,'https://ecas.ec.europa.eu/cas/eim/external/register.cgi'),
  entry_links_verified_at=coalesce(entry_links_verified_at,now()),
  capabilities=(SELECT ARRAY(SELECT DISTINCT x FROM unnest(coalesce(capabilities,'{}'::text[])||ARRAY['DISCOVERY','NOTICE_VIEW','DOCUMENT_DOWNLOAD','AUTHENTICATION','HISTORY']) x ORDER BY x)),
  updated_at=now()
WHERE canonical_domain='ted.europa.eu' AND adapter_id='ted-discovery'
  AND (authentication_entry_url IS NULL OR registration_entry_url IS NULL OR entry_links_verified_at IS NULL
    OR NOT ARRAY['DISCOVERY','NOTICE_VIEW','DOCUMENT_DOWNLOAD','AUTHENTICATION','HISTORY'] <@ coalesce(capabilities,'{}'::text[]));

COMMIT;
