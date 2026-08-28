BEGIN;

CREATE OR REPLACE FUNCTION tender.enqueue_full_autopilot()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO tender.autopilot_queue(tender_id,tender_version_id,reason,request_id,action_type,idempotency_key)
  VALUES(NEW.tender_id,NEW.id,'TENDER_VERSION_CREATED',gen_random_uuid(),'REFRESH_ENRICHMENT',
    concat('ingestion:',NEW.tender_id,':',NEW.id,':REFRESH_ENRICHMENT'))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$function$;

COMMIT;
