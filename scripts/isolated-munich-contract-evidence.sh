#!/usr/bin/env bash
set -Eeuo pipefail

: "${EXPECTED_COMMIT:?EXPECTED_COMMIT is required}"
container=${RESTORE_CONTAINER:-wb-tender-restore-verify-20260828T211025Z-db}
database=${RESTORE_DATABASE:-wb_platform_restore}
database_user=${RESTORE_DATABASE_USER:-restore_admin}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(git -C "$script_dir/.." rev-parse --show-toplevel)
expected_tree=${EXPECTED_TREE:-}
tender_id='2203e521-6be7-4760-a15e-1357f833b279'
company_id='15c3c602-aa51-4dd4-adc1-3586dc82e523'
lot_key='LOT-0000'
enrichment_version='f00be7ac-3de5-487b-b867-fe859e45c14a'

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

scalar() {
  docker exec -e 'PGOPTIONS=-c default_transaction_read_only=on' "$container" \
    psql -U "$database_user" -d "$database" -X -A -t -v ON_ERROR_STOP=1 -c "$1"
}

fingerprint() {
  scalar "SELECT concat_ws('|',
    (SELECT count(*) FROM tender.tenders),
    (SELECT count(*) FROM tender.enrichment_documents),
    (SELECT count(*) FROM tender.enrichment_fields),
    (SELECT count(*) FROM tender.calculations),
    (SELECT count(*) FROM tender.management_outputs),
    (SELECT count(*) FROM tender.calculation_input_snapshots),
    (SELECT count(*) FROM tender.configuration_active_parameters),
    (SELECT count(*) FROM tender.external_action_receipts),
    (SELECT count(*) FROM app.schema_migrations WHERE version='0155-c23-canonical-calculation-contract')
  )"
}

printf '===== SOURCE AND CLONE GATE =====\n'
actual_commit=$(git -C "$root" rev-parse HEAD)
actual_tree=$(git -C "$root" rev-parse 'HEAD^{tree}')
printf 'commit=%s\ntree=%s\n' "$actual_commit" "$actual_tree"
test "$actual_commit" = "$EXPECTED_COMMIT" || fail "source commit mismatch: expected=$EXPECTED_COMMIT actual=$actual_commit"
if [[ -n "$expected_tree" ]]; then
  test "$actual_tree" = "$expected_tree" || fail "source tree mismatch: expected=$expected_tree actual=$actual_tree"
fi
test -z "$(git -C "$root" status --porcelain)" || fail "source checkout is dirty"
test "$(docker inspect -f '{{.State.Running}}' "$container")" = true || fail "restore clone is not running"
published=$(docker inspect -f '{{range $port,$bindings := .NetworkSettings.Ports}}{{if $bindings}}{{$port}}={{json $bindings}}{{end}}{{end}}' "$container")
test -z "$published" || fail "restore clone publishes host ports: $published"
docker inspect -f 'container={{.Name}} image={{.Config.Image}} networks={{range $name,$value := .NetworkSettings.Networks}}{{$name}} {{end}}mounts={{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}} {{end}}' "$container"

before=$(fingerprint)
printf 'before_fingerprint=%s\n' "$before"

printf '\n===== EXACT READ-ONLY MUNICH CONTRACT EVIDENCE =====\n'
docker exec -i -e 'PGOPTIONS=-c default_transaction_read_only=on' "$container" \
  psql -U "$database_user" -d "$database" -X -v ON_ERROR_STOP=1 -P pager=off <<WB_SQL
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout='180s';
SET LOCAL lock_timeout='5s';

SELECT source.external_id,source.id AS tender_id,
       to_jsonb(source)->'contract_start' AS tender_contract_start,
       to_jsonb(source)->'contract_end' AS tender_contract_end,
       to_jsonb(source)->'duration_months' AS tender_duration_months,
       enrichment.id AS enrichment_version_id,enrichment.version,
       enrichment.structured_data->'contractStart' AS structured_contract_start,
       enrichment.structured_data->'contractEnd' AS structured_contract_end,
       enrichment.structured_data->'duration' AS structured_duration
FROM tender.tenders source
JOIN tender.enrichment_versions enrichment
  ON enrichment.id='$enrichment_version'::uuid
 AND enrichment.tender_id=source.id
WHERE source.id='$tender_id'::uuid;

WITH document_pages AS (
  SELECT document.id AS document_id,document.filename,document.payload_sha256,
         page.ordinality AS page_index,
         coalesce(nullif(page.value->>'pageNumber','')::integer,page.ordinality::integer) AS page_number,
         regexp_replace(coalesce(page.value->>'text',''),'[[:space:]]+',' ','g') AS page_text
  FROM tender.enrichment_documents document
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(document.extracted_data->'pages')='array'
      THEN document.extracted_data->'pages'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS page(value,ordinality)
  WHERE document.enrichment_version_id='$enrichment_version'::uuid
    AND document.fetch_status='VORHANDEN'
    AND document.procurement_verification_status='VERIFIED'
)
SELECT document_id,filename,payload_sha256,page_number,
       left(page_text,2400) AS matching_page_text
FROM document_pages
WHERE page_text~*'(Vertragsbeginn|Vertragsende|Vertragsdauer|Vertragslaufzeit|Leistungsbeginn|Leistungsende|Laufzeit|01\\.03\\.2027|28\\.02\\.2031)'
ORDER BY filename,page_number,document_id;

SELECT field.id,field.field_key,field.quality_status,field.value,
       field.provenance->>'parser' AS parser,
       field.provenance->>'selectedLotId' AS selected_lot_id,
       field.provenance
FROM tender.enrichment_fields field
WHERE field.enrichment_version_id='$enrichment_version'::uuid
  AND field.field_key~*'(contract|duration|laufzeit|beginn|ende)'
ORDER BY field.field_key,field.created_at,field.id;

SELECT result.id,result.result_version,result.lot_key,
       jsonb_pretty(result.review->'procurement') AS procurement_review,
       jsonb_pretty(result.review->'scope') AS scope_review,
       result.source_manifest
FROM tender.autopilot_results result
WHERE result.tender_id='$tender_id'::uuid
  AND result.company_id='$company_id'::uuid
  AND result.lot_key='$lot_key'
  AND result.enrichment_version_id='$enrichment_version'::uuid
ORDER BY result.result_version DESC,result.created_at DESC,result.id DESC
LIMIT 3;

ROLLBACK;
WB_SQL

after=$(fingerprint)
printf 'after_fingerprint=%s\n' "$after"
test "$before" = "$after" || fail "protected clone fingerprint changed"
printf 'PASS: Munich contract evidence was inspected read-only; the retained clone remained unchanged.\n'
