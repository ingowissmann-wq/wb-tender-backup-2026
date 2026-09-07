\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE candidate uuid:=gen_random_uuid(); old_version uuid:=gen_random_uuid(); latest uuid:=gen_random_uuid(); portal_a uuid:=gen_random_uuid(); portal_b uuid:=gen_random_uuid(); matched uuid; state text;
BEGIN
 INSERT INTO tender.portal_registry(id,canonical_domain) VALUES(portal_a,'bidder-a.example.invalid'),(portal_b,'bidder-b.example.invalid');
 INSERT INTO tender.tender_versions(id,tender_id,version,created_at) VALUES(old_version,candidate,1,now()),(latest,candidate,2,now());
 INSERT INTO tender.tender_portal_resolutions(tender_id,tender_version_id,portal_id,resolution_status) VALUES(candidate,old_version,portal_b,'UNIQUE_EVIDENCE'),(candidate,latest,portal_a,'UNIQUE_EVIDENCE');
 SELECT portal_id,mapping_status INTO matched,state FROM tender.current_tender_portal_mapping_truth WHERE tender_id=candidate;
 IF matched IS DISTINCT FROM portal_a OR state IS DISTINCT FROM 'UNIQUE_CANONICAL_PROFILE' THEN RAISE EXCEPTION 'latest_version_resolution_lost'; END IF;
 -- A publication/login link must not override the actual bidder portal.
 INSERT INTO tender.tender_external_links(tender_id,role,final_host,verification_status,evidence) VALUES(candidate,'PUBLICATION','bidder-b.example.invalid','HTTP_VERIFIED','{}');
 SELECT portal_id INTO matched FROM tender.current_tender_portal_mapping_truth WHERE tender_id=candidate;
 IF matched IS DISTINCT FROM portal_a THEN RAISE EXCEPTION 'publication_source_shadowed_bidder'; END IF;
 -- Conflicting current evidence is a review case, not an arbitrary selection.
 INSERT INTO tender.tender_external_links(tender_id,role,final_host,verification_status,evidence) VALUES(candidate,'SUBMISSION','bidder-b.example.invalid','HTTP_VERIFIED','{}');
 SELECT portal_id,mapping_status INTO matched,state FROM tender.current_tender_portal_mapping_truth WHERE tender_id=candidate;
 IF matched IS NOT NULL OR state IS DISTINCT FROM 'AMBIGUOUS' THEN RAISE EXCEPTION 'conflicting_resolution_auto_selected'; END IF;
 DELETE FROM tender.tender_external_links WHERE tender_id=candidate;
 UPDATE tender.tender_portal_resolutions SET resolution_status='REVIEW_REQUIRED' WHERE tender_version_id=latest;
 IF EXISTS(SELECT 1 FROM tender.current_tender_portal_mapping_truth WHERE tender_id=candidate) THEN RAISE EXCEPTION 'stale_or_review_resolution_selected'; END IF;
END $$;
ROLLBACK;
