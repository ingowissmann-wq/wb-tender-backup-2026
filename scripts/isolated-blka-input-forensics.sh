#!/usr/bin/env bash
set -Eeuo pipefail

: "${EXPECTED_COMMIT:?EXPECTED_COMMIT is required}"
container=${RESTORE_CONTAINER:-wb-tender-restore-verify-20260828T211025Z-db}
database=${RESTORE_DATABASE:-wb_platform_restore}
database_user=${RESTORE_DATABASE_USER:-restore_admin}
expected_tree=${EXPECTED_TREE:-}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(git -C "$script_dir/.." rev-parse --show-toplevel)
tender_id='06e91129-00c0-4820-9fbe-087e3517ce80'
company_id='15c3c602-aa51-4dd4-adc1-3586dc82e523'
lot_key='LOT-0001'
lot_id='50479867-5774-4db4-bdef-b93a7d0eb88f'
enrichment_version='5e885f85-c63e-47c8-ac5e-ab6770f9d446'

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
    (SELECT count(*) FROM app.schema_migrations WHERE version='0155-c23-canonical-calculation-contract'),
    (SELECT count(*) FROM app.schema_migrations WHERE version='0156-c11-hourly-material-contract')
  )"
}

printf '===== SOURCE AND ISOLATED-CLONE GATE =====\n'
actual_commit=$(git -C "$root" rev-parse HEAD)
actual_tree=$(git -C "$root" rev-parse 'HEAD^{tree}')
printf 'commit=%s\ntree=%s\n' "$actual_commit" "$actual_tree"
test "$actual_commit" = "$EXPECTED_COMMIT" || fail "source commit mismatch"
if [[ -n "$expected_tree" ]]; then test "$actual_tree" = "$expected_tree" || fail "source tree mismatch"; fi
test -z "$(git -C "$root" status --porcelain)" || fail "source checkout is dirty"
test "$(docker inspect -f '{{.State.Running}}' "$container")" = true || fail "isolated clone is not running"
published=$(docker inspect -f '{{range $port,$bindings := .NetworkSettings.Ports}}{{if $bindings}}{{$port}}={{json $bindings}}{{end}}{{end}}' "$container")
test -z "$published" || fail "isolated clone publishes host ports"
test "$database" = wb_platform_restore || fail "refusing non-restore database"
test "$(scalar "SELECT count(*) FROM app.schema_migrations WHERE version='0156-c11-hourly-material-contract'")" = 1 || fail "migration 156 candidate state is absent"

source_chain=$(scalar "SELECT count(*) FROM tender.tenders source JOIN tender.current_service_relevance relevance ON relevance.tender_id=source.id AND relevance.company_id='$company_id'::uuid AND relevance.service_line='cleaning' AND relevance.lot_key='$lot_key' JOIN tender.lots lot ON lot.id='$lot_id'::uuid AND lot.tender_id=source.id AND lot.external_id=relevance.lot_key JOIN tender.enrichment_context_bindings binding ON binding.tender_id=source.id AND binding.company_id=relevance.company_id AND binding.lot_id=lot.id AND binding.source_lot_id=relevance.lot_key AND binding.enrichment_version_id='$enrichment_version'::uuid JOIN tender.region_evaluations region ON region.tender_id=source.id AND region.company_id=relevance.company_id AND region.lot_id=lot.id AND region.classification='CORE_REGION' WHERE source.id='$tender_id'::uuid AND source.external_id='514707-2026' AND source.source_lifecycle_status='ACTIVE' AND relevance.relevance_status='RELEVANT' AND relevance.service_scope_gate='PASSED' AND relevance.primary_company=true")
test "$source_chain" -ge 1 || fail "exact BLKA source/lot/region chain is absent"

selected_enrichment_lot_id=$(scalar "SELECT id FROM tender.enrichment_lots WHERE enrichment_version_id='$enrichment_version'::uuid AND lot_key='$lot_key' ORDER BY id")
test "$(printf '%s\n' "$selected_enrichment_lot_id" | sed '/^$/d' | wc -l)" -eq 1 || fail "exact BLKA enrichment lot is not unique"

c22_count=$(scalar "SELECT count(*) FROM tender.configuration_active_parameters WHERE company_id='$company_id'::uuid AND service_line='cleaning' AND parameter_key='C22'")
test "$c22_count" = 0 || fail "C22 is persisted although no BLKA business approval exists"
c23_count=$(scalar "SELECT count(*) FROM tender.configuration_active_parameters active JOIN tender.configuration_changes change ON change.id=active.change_id JOIN tender.configuration_versions version ON version.id=active.version_id WHERE active.company_id='$company_id'::uuid AND active.service_line='cleaning' AND active.parameter_key='C23' AND change.new_value='1670'::jsonb AND change.unit='HOURS_PER_YEAR' AND version.status='ACTIVE'")
test "$c23_count" = 1 || fail "approved C23 exact scope is not unique"
c11_count=$(scalar "SELECT count(*) FROM tender.configuration_active_parameters active JOIN tender.configuration_changes change ON change.id=active.change_id JOIN tender.configuration_versions version ON version.id=active.version_id WHERE active.company_id='$company_id'::uuid AND active.service_line='cleaning' AND active.parameter_key='C11' AND change.new_value='0.5'::jsonb AND change.unit='EUR_PER_HOUR' AND version.status='ACTIVE'")
test "$c11_count" = 1 || fail "approved C11 exact scope is not unique"

before=$(fingerprint)
printf 'before_fingerprint=%s\n' "$before"
temporary=$(mktemp -d)
documents_file="$temporary/documents.json"
fields_file="$temporary/fields.json"
cleanup() { rm -f "$documents_file" "$fields_file"; rmdir "$temporary" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

scalar "SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id',document.id,'lot_id',document.lot_id,'filename',document.filename,
  'fetch_status',document.fetch_status,'procurement_verification_status',document.procurement_verification_status,
  'tender_association_verified',document.tender_association_verified,'lot_association_verified',document.lot_association_verified,
  'payload_sha256',document.payload_sha256,'provenance',document.provenance,'extracted_data',document.extracted_data
) ORDER BY document.filename,document.id),'[]'::jsonb)::text
FROM tender.enrichment_documents document
WHERE document.enrichment_version_id='$enrichment_version'::uuid
  AND document.fetch_status='VORHANDEN'
  AND document.procurement_verification_status='VERIFIED'" >"$documents_file"

scalar "SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id',field.id,'field_key',field.field_key,'value',field.value,
  'quality_status',field.quality_status,'provenance',field.provenance
) ORDER BY field.field_key,field.created_at,field.id),'[]'::jsonb)::text
FROM tender.enrichment_fields field
WHERE field.enrichment_version_id='$enrichment_version'::uuid
  AND (field.provenance->>'selectedLotId' IS NULL OR field.provenance->>'selectedLotId'='$selected_enrichment_lot_id')" >"$fields_file"

printf '\n===== EXACT READ-ONLY BLKA INPUT FORENSICS =====\n'
node "$root/scripts/isolated-blka-input-forensics.mjs" \
  "$documents_file" "$fields_file" "$selected_enrichment_lot_id"

after=$(fingerprint)
printf 'after_fingerprint=%s\n' "$after"
test "$before" = "$after" || fail "protected clone fingerprint changed"
printf 'persisted_C22_rows=%s\napproved_C23_rows=%s\napproved_C11_rows=%s\n' "$c22_count" "$c23_count" "$c11_count"
printf 'PASS: exact BLKA LOT-0001 input forensics completed read-only; no C22 was assumed or persisted and the isolated clone remained unchanged.\n'
