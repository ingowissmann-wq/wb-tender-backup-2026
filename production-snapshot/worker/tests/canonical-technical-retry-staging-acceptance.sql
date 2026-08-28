\set ON_ERROR_STOP on

BEGIN READ ONLY;

DO $$
DECLARE scheduled integer; invalid integer;
BEGIN
  SELECT count(*) INTO scheduled FROM tender.autopilot_queue
  WHERE reason='CANONICAL_TECHNICAL_RETRY_138';

  SELECT count(*) INTO invalid
  FROM tender.autopilot_queue queue
  LEFT JOIN tender.lots lot ON lot.id=queue.lot_id AND lot.tender_id=queue.tender_id
  LEFT JOIN tender.tender_versions version
    ON version.id=queue.tender_version_id AND version.tender_id=queue.tender_id
  LEFT JOIN tender.enrichment_versions enrichment
    ON enrichment.id=queue.enrichment_version_id AND enrichment.tender_id=queue.tender_id
  LEFT JOIN tender.current_registered_tender_company_portals registered
    ON registered.tender_id=queue.tender_id
    AND registered.company_id=queue.company_id
    AND registered.portal_id=queue.portal_id
    AND registered.credential_id=queue.credential_id
  WHERE queue.reason='CANONICAL_TECHNICAL_RETRY_138'
    AND (queue.action_type<>'RUN_FULL_PIPELINE'
      OR lot.id IS NULL OR lot.external_id<>queue.lot_key
      OR version.id IS NULL OR enrichment.id IS NULL
      OR registered.portal_id IS NULL
      OR queue.configuration_version_id IS NULL);

  IF scheduled<1 THEN RAISE EXCEPTION 'expected at least one exact technical retry fixture'; END IF;
  IF invalid<>0 THEN RAISE EXCEPTION 'technical retry validation failed for % jobs',invalid; END IF;
END $$;

SELECT status,count(*) FROM tender.autopilot_queue
WHERE reason='CANONICAL_TECHNICAL_RETRY_138'
GROUP BY status ORDER BY status;

ROLLBACK;
