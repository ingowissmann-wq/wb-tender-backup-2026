ALTER TABLE tender.required_document_working_copies
  ADD COLUMN IF NOT EXISTS overlay_data jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS editor_provenance jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE tender.required_document_working_copies
  DROP CONSTRAINT IF EXISTS required_document_working_copies_overlay_data_check;
ALTER TABLE tender.required_document_working_copies
  ADD CONSTRAINT required_document_working_copies_overlay_data_check
  CHECK(jsonb_typeof(overlay_data)='array' AND jsonb_array_length(overlay_data)<=500);

COMMENT ON COLUMN tender.required_document_working_copies.overlay_data IS
  'Normalisierte, seitenbezogene PDF-Overlay-Elemente; Working-Copy-Inhalt ist der reproduzierbar gerenderte Export.';
COMMENT ON COLUMN tender.required_document_working_copies.editor_provenance IS
  'Technische Provenance der Arbeitskopie; Auditmetadaten enthalten keine eingegebenen Textwerte.';
COMMENT ON TABLE tender.required_document_working_copies IS
  'Immutable, versionierte Arbeitskopien exakt gebundener PDF-Quellen; separate Originalformular-Provenance ist keine Voraussetzung für Overlays.';
