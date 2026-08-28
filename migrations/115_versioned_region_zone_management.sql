BEGIN;

ALTER TABLE tender.region_zones
  ADD COLUMN IF NOT EXISTS lifecycle_status text,
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS effective_until date,
  ADD COLUMN IF NOT EXISTS change_type text,
  ADD COLUMN IF NOT EXISTS change_reason text,
  ADD COLUMN IF NOT EXISTS supersedes_id uuid,
  ADD COLUMN IF NOT EXISTS superseded_by_id uuid,
  ADD COLUMN IF NOT EXISTS content_sha256 text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE tender.region_zones SET
  lifecycle_status=CASE WHEN active THEN 'ACTIVE' ELSE 'SUPERSEDED' END,
  effective_from=coalesce(effective_from,created_at::date),
  change_type=coalesce(change_type,'LEGACY_IMPORT'),
  change_reason=coalesce(change_reason,'Bestehende produktive Zonenfassung unverändert in den versionierten Vertrag übernommen.'),
  content_sha256=coalesce(content_sha256,encode(digest(concat_ws('|',code,version::text,name,regions::text,travel_rules::text),'sha256'),'hex'))
WHERE lifecycle_status IS NULL OR effective_from IS NULL OR change_type IS NULL OR change_reason IS NULL OR content_sha256 IS NULL;

ALTER TABLE tender.region_zones
  ALTER COLUMN lifecycle_status SET NOT NULL,
  ALTER COLUMN effective_from SET NOT NULL,
  ALTER COLUMN change_type SET NOT NULL,
  ALTER COLUMN change_reason SET NOT NULL,
  ALTER COLUMN content_sha256 SET NOT NULL;

ALTER TABLE tender.region_zones DROP CONSTRAINT IF EXISTS region_zones_lifecycle_status_check;
ALTER TABLE tender.region_zones ADD CONSTRAINT region_zones_lifecycle_status_check CHECK(lifecycle_status IN('ACTIVE','SUPERSEDED','RETIRED'));
ALTER TABLE tender.region_zones DROP CONSTRAINT IF EXISTS region_zones_change_type_check;
ALTER TABLE tender.region_zones ADD CONSTRAINT region_zones_change_type_check CHECK(change_type IN('CREATE','UPDATE','RELOCATION','RETIRE','LEGACY_IMPORT'));
ALTER TABLE tender.region_zones DROP CONSTRAINT IF EXISTS region_zones_effective_range_check;
ALTER TABLE tender.region_zones ADD CONSTRAINT region_zones_effective_range_check CHECK(effective_until IS NULL OR effective_until>=effective_from);
ALTER TABLE tender.region_zones DROP CONSTRAINT IF EXISTS region_zones_content_sha256_check;
ALTER TABLE tender.region_zones ADD CONSTRAINT region_zones_content_sha256_check CHECK(content_sha256 ~ '^[a-f0-9]{64}$');
ALTER TABLE tender.region_zones DROP CONSTRAINT IF EXISTS region_zones_supersedes_fk;
ALTER TABLE tender.region_zones ADD CONSTRAINT region_zones_supersedes_fk FOREIGN KEY(supersedes_id) REFERENCES tender.region_zones(id);
ALTER TABLE tender.region_zones DROP CONSTRAINT IF EXISTS region_zones_superseded_by_fk;
ALTER TABLE tender.region_zones ADD CONSTRAINT region_zones_superseded_by_fk FOREIGN KEY(superseded_by_id) REFERENCES tender.region_zones(id);
CREATE UNIQUE INDEX IF NOT EXISTS region_zones_one_active_code_idx ON tender.region_zones(code) WHERE active AND lifecycle_status='ACTIVE';

CREATE TABLE IF NOT EXISTS tender.region_zone_events(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  zone_id uuid NOT NULL REFERENCES tender.region_zones(id),
  code text NOT NULL,
  version integer NOT NULL,
  action text NOT NULL CHECK(action IN('CREATED','VERSION_CREATED','RELOCATED','RETIRED')),
  reason text NOT NULL,
  prior_zone_id uuid REFERENCES tender.region_zones(id),
  content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  actor_id uuid REFERENCES iam.users(id),
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS region_zone_events_zone_idx ON tender.region_zone_events(code,version,occurred_at);

INSERT INTO tender.region_zone_events(zone_id,code,version,action,reason,content_sha256,metadata)
SELECT zone.id,zone.code,zone.version,'CREATED',zone.change_reason,zone.content_sha256,jsonb_build_object('backfilled',true,'externalWrite',false)
FROM tender.region_zones zone
WHERE NOT EXISTS(SELECT 1 FROM tender.region_zone_events event WHERE event.zone_id=zone.id);

CREATE OR REPLACE FUNCTION tender.protect_region_zone_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'region_zone_delete_protected' USING ERRCODE='55000'; END IF;
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.version IS DISTINCT FROM OLD.version OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.regions IS DISTINCT FROM OLD.regions OR NEW.travel_rules IS DISTINCT FROM OLD.travel_rules
    OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from OR NEW.change_type IS DISTINCT FROM OLD.change_type
    OR NEW.change_reason IS DISTINCT FROM OLD.change_reason OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
    OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
  THEN RAISE EXCEPTION 'historical_region_zone_immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_region_zone_version ON tender.region_zones;
CREATE TRIGGER protect_region_zone_version BEFORE UPDATE OR DELETE ON tender.region_zones FOR EACH ROW EXECUTE FUNCTION tender.protect_region_zone_version();

CREATE OR REPLACE FUNCTION tender.protect_region_zone_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'region_zone_event_immutable' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS protect_region_zone_event ON tender.region_zone_events;
CREATE TRIGGER protect_region_zone_event BEFORE UPDATE OR DELETE ON tender.region_zone_events FOR EACH ROW EXECUTE FUNCTION tender.protect_region_zone_event();

INSERT INTO tender.audit_events(action,metadata) VALUES('REGION_ZONE_VERSIONING_ENABLED',jsonb_build_object('release','20260821-portal-regions-completion.19','deleteProtected',true,'historyImmutable',true,'externalWrite',false));
COMMIT;
