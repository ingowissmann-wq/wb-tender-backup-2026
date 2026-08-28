\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_source_hash text;
  v_source_size bigint;
  v_working_hash text;
  v_working_size bigint;
  v_external_receipts integer;
  v_submission_receipts integer;
BEGIN
  SELECT payload_sha256,octet_length(content) INTO STRICT v_source_hash,v_source_size
  FROM tender.enrichment_documents
  WHERE id='fa316b8b-3093-429a-b5df-37c9b467734f'::uuid;
  IF v_source_hash<>'f15a6a1e5b29f791e45c520917d19d9757efdc2a1a891d013446c30ca18bac90' OR v_source_size<>10640703 THEN
    RAISE EXCEPTION 'affected source PDF binding changed';
  END IF;

  SELECT sha256,octet_length(content) INTO STRICT v_working_hash,v_working_size
  FROM tender.required_document_working_copies
  WHERE id='9c61ae60-eaeb-4fce-9dc2-fe622c9c056a'::uuid
    AND required_document_id='032999f7-dc0f-4f6d-9303-67c949ae1821'::uuid
    AND version=1 AND is_current;
  IF v_working_hash<>v_source_hash OR v_working_size<>v_source_size THEN
    RAISE EXCEPTION 'untouched page-52 working-copy binding changed';
  END IF;

  IF (SELECT count(*) FROM tender.required_documents
      WHERE id=ANY(ARRAY[
        '032999f7-dc0f-4f6d-9303-67c949ae1821'::uuid,
        '29b1d8ee-0f7a-4bdf-ae07-59689d0f3185'::uuid,
        '9eabed59-f631-4443-8d23-0955213ae0ff'::uuid,
        '4bb040a0-42d0-4034-96a4-b2332643f8b9'::uuid,
        '53ad9a92-b5f7-495a-8490-ceb11f3d6f15'::uuid,
        '7927190c-bc60-4fda-ab77-a06c00b7e8c4'::uuid])
      AND tender_id='deaffd76-2c92-47a7-bf32-9e6c32c7119a'::uuid
      AND company_id='7edf1812-b5e9-4b5c-addf-95d2339362b3'::uuid
      AND lot_key='LOT-0001' AND source_document_id='fa316b8b-3093-429a-b5df-37c9b467734f'::uuid
      AND source_page IN(52,68))<>6 THEN
    RAISE EXCEPTION 'affected required-document scope changed';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM tender.required_documents WHERE id='032999f7-dc0f-4f6d-9303-67c949ae1821'::uuid AND satisfaction_status IN('MISSING','NOT_REQUIRED')
      AND requirement_description ILIKE '%nach Zuschlagserteilung%') THEN
    RAISE EXCEPTION 'page-52 evidence or status changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tender.required_documents WHERE id='4bb040a0-42d0-4034-96a4-b2332643f8b9'::uuid AND satisfaction_status IN('MISSING','NOT_REQUIRED')
      AND requirement_description ILIKE '%vor dem geplanten Einsatz%') THEN
    RAISE EXCEPTION 'page-68 evidence or status changed';
  END IF;

  UPDATE tender.required_documents SET
    requirement_classification='POST_AWARD_EVIDENCE',
    classification_reason='Nachweis ist ausdrücklich erst nach Zuschlag oder Auftragserteilung vorzulegen.',
    classification_provenance=jsonb_build_object('classifierVersion','wb-bid-time-requirement/1.0.0','rule','POST_AWARD_EXPLICIT','deterministic',true,'sourceDocumentId',source_document_id,'sourceSha256',v_source_hash,'sourcePage',source_page),
    mandatory=CASE WHEN id='032999f7-dc0f-4f6d-9303-67c949ae1821'::uuid THEN false ELSE mandatory END,
    submission_relevant=CASE WHEN id='032999f7-dc0f-4f6d-9303-67c949ae1821'::uuid THEN false ELSE submission_relevant END,
    satisfaction_status=CASE WHEN id='032999f7-dc0f-4f6d-9303-67c949ae1821'::uuid THEN 'NOT_REQUIRED' ELSE satisfaction_status END,
    not_required_reason=CASE WHEN id='032999f7-dc0f-4f6d-9303-67c949ae1821'::uuid THEN 'POST_AWARD_EVIDENCE: ausdrücklich nach Zuschlagserteilung; keine Angebotsunterlage.' ELSE not_required_reason END,
    updated_at=now()
  WHERE id=ANY(ARRAY['032999f7-dc0f-4f6d-9303-67c949ae1821'::uuid,'29b1d8ee-0f7a-4bdf-ae07-59689d0f3185'::uuid,'9eabed59-f631-4443-8d23-0955213ae0ff'::uuid]);

  UPDATE tender.required_documents SET
    requirement_classification='CONTRACT_PERFORMANCE_CLAUSE',
    classification_reason='Pflicht betrifft Vertragsdurchführung oder Personal-/Leistungseinsatz, nicht die Angebotsabgabe.',
    classification_provenance=jsonb_build_object('classifierVersion','wb-bid-time-requirement/1.0.0','rule','PERFORMANCE_TIME_EXPLICIT','deterministic',true,'sourceDocumentId',source_document_id,'sourceSha256',v_source_hash,'sourcePage',source_page),
    mandatory=CASE WHEN id='4bb040a0-42d0-4034-96a4-b2332643f8b9'::uuid THEN false ELSE mandatory END,
    submission_relevant=CASE WHEN id='4bb040a0-42d0-4034-96a4-b2332643f8b9'::uuid THEN false ELSE submission_relevant END,
    satisfaction_status=CASE WHEN id='4bb040a0-42d0-4034-96a4-b2332643f8b9'::uuid THEN 'NOT_REQUIRED' ELSE satisfaction_status END,
    not_required_reason=CASE WHEN id='4bb040a0-42d0-4034-96a4-b2332643f8b9'::uuid THEN 'CONTRACT_PERFORMANCE_CLAUSE: Nachweise spätestens 10 Tage vor geplantem Personaleinsatz; keine Angebotsunterlage.' ELSE not_required_reason END,
    updated_at=now()
  WHERE id=ANY(ARRAY['4bb040a0-42d0-4034-96a4-b2332643f8b9'::uuid,'53ad9a92-b5f7-495a-8490-ceb11f3d6f15'::uuid,'7927190c-bc60-4fda-ab77-a06c00b7e8c4'::uuid]);

  UPDATE tender.final_preflight_requirements SET
    requirement_classification='POST_AWARD_EVIDENCE',classification_reason='Nachweis ist ausdrücklich erst nach Zuschlag oder Auftragserteilung vorzulegen.',
    classification_provenance=jsonb_build_object('classifierVersion','wb-bid-time-requirement/1.0.0','rule','POST_AWARD_EXPLICIT','deterministic',true,'sourceDocumentId',source_document_id,'sourceSha256',v_source_hash,'sourcePage',source_page),
    mandatory=false,submission_relevant=false,status='NOT_REQUIRED',updated_at=now()
  WHERE context_id='b42fa3e3-d893-4928-b4f8-8d995f63f529'::uuid
    AND requirement_key='REQUIRED_DOCUMENT:CERTIFICATE:0e58c7096e5643a5a0d7';

  UPDATE tender.final_preflight_requirements SET
    requirement_classification='CONTRACT_PERFORMANCE_CLAUSE',classification_reason='Pflicht betrifft Vertragsdurchführung oder Personal-/Leistungseinsatz, nicht die Angebotsabgabe.',
    classification_provenance=jsonb_build_object('classifierVersion','wb-bid-time-requirement/1.0.0','rule','PERFORMANCE_TIME_EXPLICIT','deterministic',true,'sourceDocumentId',source_document_id,'sourceSha256',v_source_hash,'sourcePage',source_page),
    mandatory=false,submission_relevant=false,status='NOT_REQUIRED',updated_at=now()
  WHERE context_id='b42fa3e3-d893-4928-b4f8-8d995f63f529'::uuid
    AND requirement_key='REQUIRED_DOCUMENT:CERTIFICATE:06ebbc9c923fda844836';

  INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES
    (NULL,'REQUIRED_DOCUMENT_CLASSIFICATION_REPAIRED','deaffd76-2c92-47a7-bf32-9e6c32c7119a'::uuid,
      jsonb_build_object('requiredDocumentId','032999f7-dc0f-4f6d-9303-67c949ae1821','sourceDocumentId','fa316b8b-3093-429a-b5df-37c9b467734f','sourceSha256',v_source_hash,'sourcePage',52,'previousStatus','MISSING','status','NOT_REQUIRED','classification','POST_AWARD_EVIDENCE','rule','POST_AWARD_EXPLICIT','reason','Evidence explicitly due after award','workingCopyId','9c61ae60-eaeb-4fce-9dc2-fe622c9c056a','workingCopyBytesChanged',false,'externalWrite',false,'transmitted',false)),
    (NULL,'REQUIRED_DOCUMENT_CLASSIFICATION_REPAIRED','deaffd76-2c92-47a7-bf32-9e6c32c7119a'::uuid,
      jsonb_build_object('requiredDocumentId','4bb040a0-42d0-4034-96a4-b2332643f8b9','sourceDocumentId','fa316b8b-3093-429a-b5df-37c9b467734f','sourceSha256',v_source_hash,'sourcePage',68,'previousStatus','MISSING','status','NOT_REQUIRED','classification','CONTRACT_PERFORMANCE_CLAUSE','rule','PERFORMANCE_TIME_EXPLICIT','reason','Evidence due before planned personnel deployment','workingCopyBytesChanged',false,'externalWrite',false,'transmitted',false));

  IF (SELECT payload_sha256 FROM tender.enrichment_documents WHERE id='fa316b8b-3093-429a-b5df-37c9b467734f'::uuid)<>v_source_hash
     OR (SELECT octet_length(content) FROM tender.enrichment_documents WHERE id='fa316b8b-3093-429a-b5df-37c9b467734f'::uuid)<>v_source_size
     OR (SELECT sha256 FROM tender.required_document_working_copies WHERE id='9c61ae60-eaeb-4fce-9dc2-fe622c9c056a'::uuid)<>v_working_hash
     OR (SELECT octet_length(content) FROM tender.required_document_working_copies WHERE id='9c61ae60-eaeb-4fce-9dc2-fe622c9c056a'::uuid)<>v_working_size THEN
    RAISE EXCEPTION 'source or working-copy bytes changed during repair';
  END IF;

  SELECT count(*)::int INTO v_external_receipts FROM tender.external_action_receipts;
  SELECT count(*)::int INTO v_submission_receipts FROM tender.submission_receipts;
  IF v_external_receipts<>0 OR v_submission_receipts<>0 THEN
    RAISE EXCEPTION 'external or submission receipt present';
  END IF;
END $$;

COMMIT;
