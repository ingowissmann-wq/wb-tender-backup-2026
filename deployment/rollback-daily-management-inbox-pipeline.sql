BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';

ALTER TABLE tender.region_evaluations DISABLE TRIGGER region_evaluations_append_only;
DELETE FROM tender.region_evaluations
WHERE source_data->>'pipelineVersion'='wb-daily-inbox-pipeline/1.0.0';
ALTER TABLE tender.region_evaluations ENABLE TRIGGER region_evaluations_append_only;

DELETE FROM tender.management_inbox
WHERE event_fingerprint IN(SELECT pipeline_fingerprint FROM tender.inbox_pipeline_items);
DROP TABLE IF EXISTS tender.inbox_pipeline_items;
DROP TABLE IF EXISTS tender.inbox_pipeline_runs;

COMMIT;
