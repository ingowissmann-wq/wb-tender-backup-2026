BEGIN;

CREATE TABLE IF NOT EXISTS tender.calculation_user_inputs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tender.tenders(id),
  company_id uuid NOT NULL REFERENCES tender.enterprise_company_links(company_id),
  lot_key text NOT NULL,
  field_key text NOT NULL,
  field_label text NOT NULL,
  value jsonb NOT NULL,
  unit text NOT NULL,
  source_reason text NOT NULL,
  version integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES iam.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_by uuid REFERENCES tender.calculation_user_inputs(id),
  transmitted boolean NOT NULL DEFAULT false,
  CONSTRAINT calculation_user_inputs_value_object CHECK(jsonb_typeof(value) IN ('number','string')),
  CONSTRAINT calculation_user_inputs_never_transmitted CHECK(transmitted=false)
);

CREATE UNIQUE INDEX IF NOT EXISTS calculation_user_inputs_active_scope
  ON tender.calculation_user_inputs(tender_id,company_id,lot_key,field_key)
  WHERE active=true;
CREATE INDEX IF NOT EXISTS calculation_user_inputs_scope_history
  ON tender.calculation_user_inputs(tender_id,company_id,lot_key,field_key,version DESC);

COMMENT ON TABLE tender.calculation_user_inputs IS
  'Explizite interne, tender-/gesellschafts-/losgebundene Kalkulationseingaben; revisionssicher und niemals extern übertragen.';

COMMIT;

