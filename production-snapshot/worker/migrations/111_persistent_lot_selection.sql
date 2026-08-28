BEGIN;

CREATE TABLE IF NOT EXISTS tender.user_lot_selections(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES saas.tenants(id),
  user_id uuid NOT NULL REFERENCES iam.users(id),
  tender_id uuid NOT NULL REFERENCES tender.tenders(id),
  company_id uuid NOT NULL,
  lot_key text NOT NULL CHECK(btrim(lot_key)<>''),
  selected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,tender_id,company_id)
);

CREATE OR REPLACE FUNCTION tender.validate_user_lot_selection() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM saas.legacy_company_tenant_bindings binding
    WHERE binding.tenant_id=NEW.tenant_id AND binding.company_id=NEW.company_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='lot_selection_company_tenant_mismatch';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM tender.current_participation_eligible_lots lot
    WHERE lot.tender_id=NEW.tender_id AND lot.lot_key=NEW.lot_key
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='lot_selection_not_participation_eligible';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS validate_user_lot_selection ON tender.user_lot_selections;
CREATE TRIGGER validate_user_lot_selection BEFORE INSERT OR UPDATE OF tenant_id,company_id,tender_id,lot_key
ON tender.user_lot_selections FOR EACH ROW EXECUTE FUNCTION tender.validate_user_lot_selection();

ALTER TABLE tender.user_lot_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender.user_lot_selections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS runtime_scope ON tender.user_lot_selections;
CREATE POLICY runtime_scope ON tender.user_lot_selections
USING(tender.runtime_tenant_allowed(tenant_id) AND tender.runtime_company_allowed(company_id)
  AND (user_id=nullif(current_setting('app.actor_user_id',true),'')::uuid OR 'tender.admin'=ANY(string_to_array(current_setting('app.permissions',true),','))))
WITH CHECK(tender.runtime_tenant_allowed(tenant_id) AND tender.runtime_company_allowed(company_id)
  AND user_id=nullif(current_setting('app.actor_user_id',true),'')::uuid);

CREATE INDEX IF NOT EXISTS user_lot_selections_scope ON tender.user_lot_selections(tenant_id,company_id,tender_id,user_id);
GRANT SELECT,INSERT,UPDATE,DELETE ON tender.user_lot_selections TO tender_api_runtime;

COMMIT;
