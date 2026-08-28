BEGIN;

CREATE TABLE IF NOT EXISTS tender.deadline_review_cases(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tender_id uuid NOT NULL UNIQUE REFERENCES tender.tenders(id) ON DELETE CASCADE,
  source_code text NOT NULL,review_status text NOT NULL DEFAULT 'OPEN',reason_code text NOT NULL,
  structured_evidence_found boolean NOT NULL DEFAULT false,document_evidence_found boolean NOT NULL DEFAULT false,
  authoritative_deadline timestamptz,confidence numeric(5,4),provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(review_status IN('OPEN','RESOLVED','NOT_PUBLISHED','CLOSED')),CHECK(authoritative_deadline IS NULL OR confidence IS NOT NULL)
);
INSERT INTO tender.deadline_review_cases(tender_id,source_code,reason_code,provenance)
SELECT t.id,t.source_code,'AUTHORITATIVE_DEADLINE_NOT_PUBLISHED',jsonb_build_object('source','DOE_OCDS','fieldsChecked',jsonb_build_array('tender.tenderPeriod','tender.enquiryPeriod','tender.awardPeriod'),'invented',false)
FROM tender.tenders t WHERE t.source_code='DOE' AND t.participation_deadline IS NULL AND t.offer_deadline IS NULL ON CONFLICT(tender_id) DO NOTHING;

ALTER TABLE tender.portal_registry ADD COLUMN IF NOT EXISTS parent_portal_id uuid REFERENCES tender.portal_registry(id);
ALTER TABLE tender.portal_registry ADD COLUMN IF NOT EXISTS entrypoint_type text NOT NULL DEFAULT 'ROOT';
ALTER TABLE tender.portal_registry ADD COLUMN IF NOT EXISTS portal_family_key text;
UPDATE tender.portal_registry SET portal_family_key=coalesce(portal_family_key,adapter_id,canonical_domain);
UPDATE tender.portal_registry SET entrypoint_type='ROOT',parent_portal_id=NULL WHERE adapter_id='deutsche-evergabe' AND canonical_domain='www.deutsche-evergabe.de';
UPDATE tender.portal_registry child SET entrypoint_type='BIDDER',parent_portal_id=parent.id
FROM tender.portal_registry parent WHERE child.adapter_id='deutsche-evergabe' AND child.canonical_domain='bieterzugang.deutsche-evergabe.de'
 AND parent.adapter_id='deutsche-evergabe' AND parent.canonical_domain='www.deutsche-evergabe.de';
CREATE UNIQUE INDEX IF NOT EXISTS portal_registry_adapter_entrypoint_unique ON tender.portal_registry(adapter_id,entrypoint_type) WHERE adapter_id IS NOT NULL;

CREATE OR REPLACE VIEW tender.current_portal_capability_truth AS
WITH current_profiles AS(
 SELECT DISTINCT ON(p.portal_id) p.id,p.portal_id FROM tender.portal_capability_profiles p
 ORDER BY p.portal_id,p.profile_version DESC,p.created_at DESC
), current_features AS(
 SELECT f.*,p.portal_id FROM current_profiles p JOIN tender.portal_capability_features f ON f.profile_id=p.id
)
SELECT r.portal_family_key,f.feature_key,
  bool_and(f.portal_support='SUPPORTED') portal_supported,
  bool_and(f.autopilot_supported) autopilot_supported,
  bool_and(f.actively_configured) configured,
  bool_and(f.production_tested) production_tested,
  bool_and(f.browser_acceptance_passed) browser_accepted,
  min(f.verified_at) last_verified,
  CASE WHEN bool_and(f.portal_support='SUPPORTED' AND f.autopilot_supported AND f.actively_configured AND f.production_tested AND f.browser_acceptance_passed) THEN NULL
       ELSE 'CAPABILITY_EVIDENCE_INCOMPLETE' END error,
  CASE WHEN bool_and(f.portal_support='SUPPORTED') THEN 'SUPPORTED' ELSE 'UNKNOWN' END portal_support,
  bool_and(f.actively_configured) actively_configured,
  bool_and(f.browser_acceptance_passed) browser_acceptance_passed,
  min(f.verified_at) verified_at,
  CASE WHEN bool_and(f.portal_support='SUPPORTED' AND f.autopilot_supported AND f.actively_configured AND f.production_tested AND f.browser_acceptance_passed) THEN NULL
       ELSE 'CAPABILITY_EVIDENCE_INCOMPLETE' END evidence_note
FROM tender.portal_registry r JOIN current_features f ON f.portal_id=r.id
GROUP BY r.portal_family_key,f.feature_key;

-- Official HTTPS entry points verified read-only on 2026-08-24. This records
-- link identity only; it deliberately does not upgrade adapter capabilities.
UPDATE tender.portal_registry SET bidder_area_url='https://ted.europa.eu/en/search/result',entry_links_verified_at=NULL,entry_links_verified_by=NULL
 WHERE canonical_domain='ted.europa.eu';
UPDATE tender.portal_registry SET bidder_area_url='https://www.evergabe-online.de/search.html',entry_links_verified_at=NULL,entry_links_verified_by=NULL
 WHERE canonical_domain='www.evergabe-online.de';
UPDATE tender.portal_registry SET bidder_area_url='https://dtvp.de/ausschreibungen/',entry_links_verified_at=NULL,entry_links_verified_by=NULL
 WHERE canonical_domain IN('dtvp.de','www.dtvp.de');
UPDATE tender.portal_registry SET bidder_area_url='https://www.vergabe24.de/',authentication_entry_url='https://login.vergabe24.de/Account/Login',entry_links_verified_at=NULL,entry_links_verified_by=NULL
 WHERE canonical_domain='www.vergabe24.de';
UPDATE tender.portal_registry SET bidder_area_url='https://www.vergabe.bayern.de/',authentication_entry_url='https://my.vergabe.bayern.de/',entry_links_verified_at=NULL,entry_links_verified_by=NULL
 WHERE canonical_domain='www.evergabe.bayern.de';
UPDATE tender.portal_registry SET authentication_entry_url='https://portal.deutsche-evergabe.de/Account/Login',bidder_area_url='https://www.deutsche-evergabe.de/auftragnehmer/index.html',entry_links_verified_at=NULL,entry_links_verified_by=NULL
 WHERE adapter_id='deutsche-evergabe';
UPDATE tender.portal_registry SET authentication_entry_url='https://vergabemarktplatz.brandenburg.de/VMPCenter/company/login.do',bidder_area_url='https://vergabemarktplatz.brandenburg.de/VMPCenter/company/welcome.do',entry_links_verified_at=NULL,entry_links_verified_by=NULL
 WHERE canonical_domain='vergabemarktplatz.brandenburg.de';
UPDATE tender.portal_registry SET bidder_area_url='https://www.evergabe.de/ausschreibungen',entry_links_verified_at=NULL,entry_links_verified_by=NULL
 WHERE canonical_domain='www.evergabe.de';

CREATE OR REPLACE FUNCTION tender.reject_unscoped_portal_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action_type IN('TEST_LOGIN','TEST_DOCUMENT_FETCH','RUN_FULL_PIPELINE','DOWNLOAD_DOCUMENTS') AND (
    NEW.company_id IS NULL OR NEW.tender_id IS NULL OR NOT EXISTS(
      SELECT 1 FROM tender.current_registered_tender_company_portals scope
      WHERE scope.tender_id=NEW.tender_id AND scope.company_id=NEW.company_id
        AND (NEW.portal_id IS NULL OR scope.portal_id=NEW.portal_id)
    )) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='registered_portal_scope_required_before_enqueue'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS autopilot_queue_scope_guard ON tender.autopilot_queue;
CREATE TRIGGER autopilot_queue_scope_guard BEFORE INSERT OR UPDATE OF tender_id,company_id,portal_id,action_type ON tender.autopilot_queue FOR EACH ROW EXECUTE FUNCTION tender.reject_unscoped_portal_job();

INSERT INTO tender.autopilot_dlq_classifications(queue_id,tender_id,lot_key,company_id,service_scope,original_created_at,release_version,worker_version,original_error_class,original_safe_description,reproduction_status,current_relevance,resolution,evidence,classified_by_release)
SELECT q.id,q.tender_id,q.lot_key,q.company_id,q.service_scope,q.created_at,'20260824-tender-safety-repair.1','20260824-tender-safety-repair.1',
 'REGISTERED_PORTAL_SCOPE_NOT_FOUND','Historical fan-out occurred before an exact registered portal/company scope existed','REPRODUCED',
 CASE WHEN t.source_lifecycle_status='ACTIVE' THEN 'ACTIVE' ELSE 'STALE' END,
 CASE WHEN t.source_lifecycle_status='ACTIVE' AND s.portal_id IS NOT NULL THEN 'RESOLVED_BY_CURRENT_RELEASE' ELSE 'OBSOLETE_PIPELINE_VERSION' END,
 jsonb_build_object('exactScopeNowExists',s.portal_id IS NOT NULL,'sourceLifecycle',t.source_lifecycle_status,'externalWrite',false),
 '20260824-tender-safety-repair.1'
FROM tender.autopilot_queue q JOIN tender.tenders t ON t.id=q.tender_id
LEFT JOIN tender.current_registered_tender_company_portals s ON s.tender_id=q.tender_id AND s.company_id=q.company_id
WHERE q.status='DEAD_LETTER' AND coalesce(q.safe_error_code,q.error_code)='REGISTERED_PORTAL_SCOPE_NOT_FOUND'
ON CONFLICT DO NOTHING;

INSERT INTO tender.autopilot_queue(tender_id,tender_version_id,reason,status,attempt,next_attempt_at,request_id,action_type,notice_id,lot_id,company_id,service_scope,portal_id,credential_id,enrichment_version_id,idempotency_key,created_by,lot_key,max_attempts)
SELECT q.tender_id,q.tender_version_id,'DLQ_EXACT_SCOPE_RECONCILIATION','QUEUED',0,
 now()+make_interval(secs=>mod(row_number() OVER(ORDER BY q.created_at,q.id)::int,86400)),gen_random_uuid(),q.action_type,q.notice_id,q.lot_id,q.company_id,q.service_scope,s.portal_id,s.credential_id,q.enrichment_version_id,
 encode(digest('repair-replay-v1:'||q.id::text,'sha256'),'hex'),q.created_by,q.lot_key,coalesce(q.max_attempts,5)
FROM tender.autopilot_queue q JOIN tender.tenders t ON t.id=q.tender_id AND t.source_lifecycle_status='ACTIVE'
JOIN tender.current_registered_tender_company_portals s ON s.tender_id=q.tender_id AND s.company_id=q.company_id
WHERE q.status='DEAD_LETTER' AND coalesce(q.safe_error_code,q.error_code)='REGISTERED_PORTAL_SCOPE_NOT_FOUND'
ON CONFLICT DO NOTHING;

UPDATE tender.required_documents d SET satisfaction_status='MANUAL_REVIEW_REQUIRED',updated_at=now()
FROM tender.tenders t WHERE t.id=d.tender_id AND t.source_lifecycle_status='ACTIVE' AND d.mandatory AND d.submission_relevant
 AND d.requirement_classification IS NULL AND d.satisfaction_status='MISSING';
UPDATE tender.enrichment_documents SET procurement_verification_status='REVIEW_REQUIRED'
WHERE procurement_relevant AND procurement_verification_status<>'REVIEW_REQUIRED'
 AND (NOT lot_association_verified OR NOT tender_association_verified OR fetch_status IN('DOWNLOAD_FEHLGESCHLAGEN','PARSER_FEHLER'));
-- Avoid WAL churn on repeated/forward-recovery runs.

COMMIT;
