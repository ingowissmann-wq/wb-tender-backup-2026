BEGIN;

ALTER TABLE tender.favorites
  ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS company_id uuid,
  ADD COLUMN IF NOT EXISTS lot_key text,
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS note text,
  ADD COLUMN IF NOT EXISTS priority smallint NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE tender.favorites SET id=gen_random_uuid() WHERE id IS NULL;
ALTER TABLE tender.favorites ALTER COLUMN id SET NOT NULL;

ALTER TABLE tender.favorites DROP CONSTRAINT IF EXISTS favorites_pkey;
ALTER TABLE tender.favorites ADD CONSTRAINT favorites_pkey PRIMARY KEY(id);
ALTER TABLE tender.favorites DROP CONSTRAINT IF EXISTS favorites_priority_check;
ALTER TABLE tender.favorites ADD CONSTRAINT favorites_priority_check CHECK(priority BETWEEN 1 AND 5);
ALTER TABLE tender.favorites DROP CONSTRAINT IF EXISTS favorites_company_id_fkey;
ALTER TABLE tender.favorites ADD CONSTRAINT favorites_company_id_fkey
  FOREIGN KEY(company_id) REFERENCES tender.enterprise_company_links(company_id);

CREATE UNIQUE INDEX IF NOT EXISTS favorites_exact_context_unique
  ON tender.favorites(
    user_id,
    tender_id,
    COALESCE(company_id,'00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(lot_key,'')
  );
CREATE INDEX IF NOT EXISTS favorites_user_updated
  ON tender.favorites(user_id,updated_at DESC,id);

COMMENT ON TABLE tender.favorites IS
  'Interne, benutzerbezogene Favoriten mit unveränderlicher Tender-/Gesellschaft-/Los-Bindung; keine externe Übertragung.';

COMMIT;
