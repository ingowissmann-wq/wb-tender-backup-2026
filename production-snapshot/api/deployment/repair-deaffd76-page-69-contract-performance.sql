\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_source_hash text;
  v_source_size bigint;
BEGIN
  SELECT payload_sha256,octet_length(content) INTO STRICT v_source_hash,v_source_size
  FROM tender.enrichment_documents WHERE id='fa316b8b-3093-429a-b5df-37c9b467734f'::uuid;
  IF v_source_hash<>'f15a6a1e5b29f791e45c520917d19d9757efdc2a1a891d013446c30ca18bac90' OR v_source_size<>10640703 THEN
    RAISE EXCEPTION 'page-69 source PDF binding changed';
  END IF;

  IF NOT EXISTS(SELECT 1 FROM tender.required_documents WHERE id='32f6f6b6-6eb3-4324-b928-2f59d33cfdf9'::uuid
      AND tender_id='deaffd76-2c92-47a7-bf32-9e6c32c7119a'::uuid AND company_id='7edf1812-b5e9-4b5c-addf-95d2339362b3'::uuid
      AND lot_key='LOT-0001' AND source_page=69 AND satisfaction_status='MISSING' AND current_upload_id IS NULL
      AND requirement_description ILIKE '%vor dem Einsatz%') THEN
    RAISE EXCEPTION 'active page-69 required-document evidence or status changed';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM tender.final_preflight_requirements WHERE id='750f67fe-df19-4cc0-8d11-d342bd166e87'::uuid AND status='MISSING' AND source_page=69)
     OR NOT EXISTS(SELECT 1 FROM tender.final_preflight_requirements WHERE id='ab0c98df-3d5d-408c-a66c-b56b6ac092ca'::uuid AND status='USER_CONFIRMATION_REQUIRED' AND source_page=69) THEN
    RAISE EXCEPTION 'active page-69 final-preflight evidence or status changed';
  END IF;

  IF NOT EXISTS(SELECT 1 FROM tender.required_documents r JOIN tender.required_document_working_copies w ON w.required_document_id=r.id AND w.is_current JOIN tender.required_document_uploads u ON u.id=r.current_upload_id
      WHERE r.id='668db284-7f9a-49c2-aba8-220514ce9361'::uuid AND r.source_page=83 AND r.satisfaction_status='VALIDATED'
        AND w.id='4a9ca240-bd8a-4115-a29b-220c4014ae9b'::uuid AND w.version=2 AND w.sha256='bf1eeac2a290670c34bd2e3881fe9e42be9a08d47ce5521ba98ea540eaa02750'
        AND u.id='75a264f3-46c4-4ec8-869b-aeb02b5a2437'::uuid AND u.validation_status='VALIDATED' AND u.sha256=w.sha256)
     OR NOT EXISTS(SELECT 1 FROM tender.required_documents r JOIN tender.required_document_working_copies w ON w.required_document_id=r.id AND w.is_current JOIN tender.required_document_uploads u ON u.id=r.current_upload_id
      WHERE r.id='a58434c8-0b7b-4f7f-9d8d-6ceedc3059f1'::uuid AND r.source_page=83 AND r.satisfaction_status='VALIDATED'
        AND w.id='3e6a26e5-0a5f-447d-af23-a78b5ae6fab7'::uuid AND w.version=2 AND w.sha256='747a95b81a5b0a84094e2f88242e08f3d8f6617aa950682717b1fc6369239232'
        AND u.id='ead865af-2c1f-4caf-93c7-2e2e72bb9249'::uuid AND u.validation_status='VALIDATED' AND u.sha256=w.sha256) THEN
    RAISE EXCEPTION 'page-83 review state changed before repair';
  END IF;

  UPDATE tender.required_documents SET
    requirement_classification='CONTRACT_PERFORMANCE_CLAUSE',
    classification_reason='Pflicht betrifft Vertragsdurchführung oder Personal-/Leistungseinsatz, nicht die Angebotsabgabe.',
    classification_provenance=jsonb_build_object('classifierVersion','wb-bid-time-requirement/1.0.0','rule','PERFORMANCE_TIME_EXPLICIT','deterministic',true,'sourceDocumentId',source_document_id,'sourceSha256',v_source_hash,'sourcePage',source_page),
    mandatory=CASE WHEN id='32f6f6b6-6eb3-4324-b928-2f59d33cfdf9'::uuid THEN false ELSE mandatory END,
    submission_relevant=CASE WHEN id='32f6f6b6-6eb3-4324-b928-2f59d33cfdf9'::uuid THEN false ELSE submission_relevant END,
    satisfaction_status=CASE WHEN id='32f6f6b6-6eb3-4324-b928-2f59d33cfdf9'::uuid THEN 'NOT_REQUIRED' ELSE satisfaction_status END,
    not_required_reason=CASE WHEN id='32f6f6b6-6eb3-4324-b928-2f59d33cfdf9'::uuid THEN 'CONTRACT_PERFORMANCE_CLAUSE: Führungszeugnis vor Personaleinsatz und während Vertragsdurchführung; keine Angebotsunterlage.' ELSE not_required_reason END,
    updated_at=now()
  WHERE id=ANY(ARRAY['09b2128f-cff9-4e7c-838c-79fcae53c51e'::uuid,'32f6f6b6-6eb3-4324-b928-2f59d33cfdf9'::uuid,'c04e8196-584d-4243-82c5-c8be5c5d0253'::uuid]);

  UPDATE tender.final_preflight_requirements SET
    requirement_classification='CONTRACT_PERFORMANCE_CLAUSE',
    classification_reason='Pflicht betrifft Vertragsdurchführung oder Personal-/Leistungseinsatz, nicht die Angebotsabgabe.',
    classification_provenance=jsonb_build_object('classifierVersion','wb-bid-time-requirement/1.0.0','rule','PERFORMANCE_TIME_EXPLICIT','deterministic',true,'sourceDocumentId',source_document_id,'sourceSha256',v_source_hash,'sourcePage',source_page),
    mandatory=CASE WHEN id=ANY(ARRAY['750f67fe-df19-4cc0-8d11-d342bd166e87'::uuid,'ab0c98df-3d5d-408c-a66c-b56b6ac092ca'::uuid]) THEN false ELSE mandatory END,
    submission_relevant=CASE WHEN id=ANY(ARRAY['750f67fe-df19-4cc0-8d11-d342bd166e87'::uuid,'ab0c98df-3d5d-408c-a66c-b56b6ac092ca'::uuid]) THEN false ELSE submission_relevant END,
    status=CASE WHEN id=ANY(ARRAY['750f67fe-df19-4cc0-8d11-d342bd166e87'::uuid,'ab0c98df-3d5d-408c-a66c-b56b6ac092ca'::uuid]) THEN 'NOT_REQUIRED' ELSE status END,
    updated_at=now()
  WHERE context_id='b42fa3e3-d893-4928-b4f8-8d995f63f529'::uuid AND source_page=69;

  UPDATE tender.final_preflight_user_actions SET status='COMPLETED',completed_at=now(),updated_at=now()
  WHERE requirement_id=ANY(ARRAY['750f67fe-df19-4cc0-8d11-d342bd166e87'::uuid,'ab0c98df-3d5d-408c-a66c-b56b6ac092ca'::uuid]) AND status IN('OPEN','IN_PROGRESS');

  UPDATE tender.final_preflight_contexts c SET readiness_status=CASE
    WHEN EXISTS(SELECT 1 FROM tender.final_preflight_requirements f WHERE f.context_id=c.id AND f.status NOT IN('VALIDATED','NOT_REQUIRED','SUPERSEDED') AND f.manual_submission_relevance_override IS DISTINCT FROM false AND (f.human_action_required OR f.status IN('USER_CONFIRMATION_REQUIRED','MANAGEMENT_REVIEW_REQUIRED','MANUAL_REVIEW_REQUIRED'))) THEN 'WAITING_FOR_USER_INPUT'
    WHEN EXISTS(SELECT 1 FROM tender.final_preflight_requirements f WHERE f.context_id=c.id AND f.status NOT IN('VALIDATED','NOT_REQUIRED','SUPERSEDED') AND f.manual_submission_relevance_override IS DISTINCT FROM false) THEN 'PACKAGE_INCOMPLETE'
    ELSE c.readiness_status END,updated_at=now()
  WHERE c.id='b42fa3e3-d893-4928-b4f8-8d995f63f529'::uuid;

  INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES
    (NULL,'REQUIRED_DOCUMENT_CLASSIFICATION_REPAIRED','deaffd76-2c92-47a7-bf32-9e6c32c7119a'::uuid,jsonb_build_object('requiredDocumentId','32f6f6b6-6eb3-4324-b928-2f59d33cfdf9','companyId','7edf1812-b5e9-4b5c-addf-95d2339362b3','lotKey','LOT-0001','sourceDocumentId','fa316b8b-3093-429a-b5df-37c9b467734f','sourceSha256',v_source_hash,'sourcePage',69,'previousStatus','MISSING','status','NOT_REQUIRED','classification','CONTRACT_PERFORMANCE_CLAUSE','rule','PERFORMANCE_TIME_EXPLICIT','reason','Evidence due before personnel deployment and during contract performance','manualOverride',false,'workingCopyBytesChanged',false,'externalWrite',false,'transmitted',false)),
    (NULL,'FINAL_PREFLIGHT_CLASSIFICATION_REPAIRED','deaffd76-2c92-47a7-bf32-9e6c32c7119a'::uuid,jsonb_build_object('finalPreflightRequirementIds',jsonb_build_array('750f67fe-df19-4cc0-8d11-d342bd166e87','ab0c98df-3d5d-408c-a66c-b56b6ac092ca'),'companyId','7edf1812-b5e9-4b5c-addf-95d2339362b3','lotKey','LOT-0001','sourceDocumentId','fa316b8b-3093-429a-b5df-37c9b467734f','sourceSha256',v_source_hash,'sourcePage',69,'classification','CONTRACT_PERFORMANCE_CLAUSE','rule','PERFORMANCE_TIME_EXPLICIT','manualOverride',false,'externalWrite',false,'transmitted',false));

  IF EXISTS(SELECT 1 FROM tender.required_documents WHERE tender_id='deaffd76-2c92-47a7-bf32-9e6c32c7119a'::uuid AND company_id='7edf1812-b5e9-4b5c-addf-95d2339362b3'::uuid AND lot_key='LOT-0001' AND source_page=69 AND satisfaction_status NOT IN('VALIDATED','NOT_REQUIRED','SUPERSEDED'))
     OR EXISTS(SELECT 1 FROM tender.final_preflight_requirements WHERE context_id='b42fa3e3-d893-4928-b4f8-8d995f63f529'::uuid AND source_page=69 AND status NOT IN('VALIDATED','NOT_REQUIRED','SUPERSEDED')) THEN
    RAISE EXCEPTION 'page-69 blocker remains after repair';
  END IF;
  IF (SELECT count(*) FROM tender.external_action_receipts)<>0 OR (SELECT count(*) FROM tender.submission_receipts)<>0 THEN RAISE EXCEPTION 'external or submission receipt present'; END IF;
END $$;

COMMIT;
