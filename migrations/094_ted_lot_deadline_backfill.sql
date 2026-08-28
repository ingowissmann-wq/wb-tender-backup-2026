BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30min';
SELECT set_config('wb_tender.suppress_autopilot_enqueue','true',true);

CREATE TEMP TABLE wb_ted_deadline_backfill ON COMMIT DROP AS
WITH latest_raw AS (
  SELECT DISTINCT ON(source_code,external_id) external_id,raw_json
  FROM tender.import_raw_payloads
  WHERE source_code='TED'
  ORDER BY source_code,external_id,retrieved_at DESC,created_at DESC
), parsed AS (
  SELECT raw.external_id,item.value deadline_text,
    CASE
      WHEN item.value ~ '^\d{4}-\d{2}-\d{2}$'
        THEN (item.value::date + 1)::timestamp AT TIME ZONE 'Europe/Berlin'
      WHEN item.value ~ '(Z|[+-]\d{2}:?\d{2})$'
        THEN item.value::timestamptz
    END deadline_at
  FROM latest_raw raw
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(raw.raw_json->'deadline-receipt-tender-date-lot')='array'
      THEN raw.raw_json->'deadline-receipt-tender-date-lot' ELSE '[]'::jsonb END
  ) item
), latest_deadline AS (
  SELECT DISTINCT ON(external_id) external_id,deadline_text,deadline_at
  FROM parsed WHERE deadline_at IS NOT NULL
  ORDER BY external_id,deadline_at DESC,deadline_text DESC
)
SELECT tender.id tender_id,tender.external_id,deadline.deadline_text,deadline.deadline_at,
       version.normalized_data,version.source_sha256,version.source_timestamp,
       coalesce(version.version,0)+1 next_version
FROM latest_deadline deadline
JOIN tender.tenders tender ON tender.source_code='TED' AND tender.external_id=deadline.external_id AND tender.data_class='PUBLIC_REAL'
JOIN LATERAL(
  SELECT version,normalized_data,source_sha256,source_timestamp
  FROM tender.tender_versions WHERE tender_id=tender.id
  ORDER BY version DESC,created_at DESC LIMIT 1
) version ON true
WHERE tender.offer_deadline IS DISTINCT FROM deadline.deadline_at;

INSERT INTO tender.tender_versions(tender_id,version,source_sha256,normalized_data,change_kind,source_timestamp)
SELECT tender_id,next_version,source_sha256,
       jsonb_set(normalized_data,'{offerDeadline}',to_jsonb(deadline_text),true),
       'UPDATED',source_timestamp
FROM wb_ted_deadline_backfill;

UPDATE tender.tenders tender
SET offer_deadline=backfill.deadline_at,
    source_lifecycle_status=CASE
      WHEN tender.source_withdrawn_at IS NOT NULL THEN 'WITHDRAWN'
      WHEN backfill.deadline_at<=now() THEN 'EXPIRED'
      ELSE 'ACTIVE'
    END,
    last_synced_at=coalesce(tender.last_synced_at,now()),
    updated_at=now()
FROM wb_ted_deadline_backfill backfill
WHERE tender.id=backfill.tender_id;

CREATE INDEX IF NOT EXISTS tenders_wb_active_deadline_idx
  ON tender.tenders(offer_deadline,publication_date DESC,updated_at DESC,id)
  WHERE data_class='PUBLIC_REAL' AND source_lifecycle_status='ACTIVE'
    AND wb_relevance_status='RELEVANT' AND classification_confidence='HIGH'
    AND assigned_service_line IS NOT NULL AND offer_deadline IS NOT NULL;

COMMIT;
