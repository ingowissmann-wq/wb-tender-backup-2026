\set ON_ERROR_STOP on

-- Isolated-clone-only browser fixture.  The guards deliberately reject any
-- database that does not contain exactly this pre-existing CANARY tender.
DO $fixture$
DECLARE
  target_id uuid := '0035e38a-6dba-4e10-a234-fedbc08415df';
  matched integer;
BEGIN
  SELECT count(*) INTO matched
  FROM tender.tenders
  WHERE id = target_id
    AND ((source_code = 'CANARY' AND external_id LIKE 'canary-%')
      OR (source_code = 'DOE' AND external_id = 'canary-portal-access-button'));
  IF matched <> 1 THEN
    RAISE EXCEPTION 'isolated CANARY fixture guard failed (matched=%)', matched;
  END IF;

  INSERT INTO tender.sources(code,name,interface,base_url,enabled)
  VALUES('DOE','Isolierte DOE-Canary-Quelle','fixture','https://oeffentlichevergabe.de',false)
  ON CONFLICT(code) DO NOTHING;

  UPDATE tender.tenders
  SET source_code = 'DOE',
      source_url = 'https://oeffentlichevergabe.de/api/notices/canary-portal-access-button?format=ocds',
      external_id = 'canary-portal-access-button',
      publication_date = current_date,
      offer_deadline = now() + interval '30 days'
  WHERE id = target_id;

  PERFORM set_config('session_replication_role', 'replica', true);
  INSERT INTO tender.tender_versions(id,tender_id,version,source_sha256,normalized_data,change_kind)
  VALUES(
    'b412cd94-3275-4fcd-a4f6-b26e1dd62e51',target_id,1,repeat('0',64),
    jsonb_build_object('raw',jsonb_build_object(
      'uri', 'https://oeffentlichevergabe.de/api/notices/canary-portal-access-button?format=ocds',
      'tender', jsonb_build_object(
        'documents', jsonb_build_array(jsonb_build_object(
          'title', 'Isolierter Canary-Portallink',
          'url', 'https://www.meinauftrag.rib.de/public/DetailsByPlatformIdAndTenderId/platformId/3/tenderId/153908'
        ))
      )
    )),
    'INITIAL'
  )
  ON CONFLICT(tender_id,version) DO UPDATE SET normalized_data=excluded.normalized_data;

  INSERT INTO tender.enrichment_versions(
    id,tender_id,version,source_code,notice_identifier,retrieved_at,source_url,
    payload_sha256,raw_payload,raw_content_type,structured_data,quality_summary,
    mapper_version,parser_version,historical
  ) VALUES(
    'a2b9fa74-0d4b-4f8b-82f3-62ed270dc44a',target_id,1,'DOE',
    'canary-portal-access-button',now(),
    'https://oeffentlichevergabe.de/api/notices/canary-portal-access-button?format=ocds',
    repeat('1',64),decode('','hex'),'application/json','{}'::jsonb,'{}'::jsonb,
    'isolated-canary','isolated-canary',false
  )
  ON CONFLICT(tender_id,version) DO NOTHING;
END
$fixture$;
