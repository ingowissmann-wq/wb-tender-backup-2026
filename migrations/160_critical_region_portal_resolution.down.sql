BEGIN;
DO $$
DECLARE saved record; option_value text; marker jsonb;
BEGIN
  IF (SELECT count(*) FROM tender.release_160_view_snapshot)<>2 THEN
    RAISE EXCEPTION 'migration_160_view_snapshot_incomplete';
  END IF;
  SELECT previous_marker INTO marker FROM tender.release_160_view_snapshot LIMIT 1;
  FOR saved IN SELECT * FROM tender.release_160_view_snapshot
    ORDER BY CASE view_name WHEN 'current_tender_portal_mapping_truth' THEN 0 ELSE 1 END
  LOOP
    EXECUTE format('CREATE OR REPLACE VIEW tender.%I AS %s',saved.view_name,saved.definition);
    FOR option_value IN SELECT unnest(c.reloptions) FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='tender' AND c.relname=saved.view_name
    LOOP
      EXECUTE format('ALTER VIEW tender.%I RESET (%I)',saved.view_name,split_part(option_value,'=',1));
    END LOOP;
    FOREACH option_value IN ARRAY coalesce(saved.options,'{}'::text[]) LOOP
      EXECUTE format('ALTER VIEW tender.%I SET (%I=%L)',saved.view_name,split_part(option_value,'=',1),split_part(option_value,'=',2));
    END LOOP;
    EXECUTE format('COMMENT ON VIEW tender.%I IS %L',saved.view_name,saved.description);
  END LOOP;
  DELETE FROM app.schema_migrations WHERE version='0160-critical-region-portal-resolution';
  IF marker IS NOT NULL THEN
    INSERT INTO app.schema_migrations SELECT (jsonb_populate_record(NULL::app.schema_migrations,marker)).*;
  END IF;
END $$;
DROP TABLE tender.release_160_view_snapshot;
COMMIT;
