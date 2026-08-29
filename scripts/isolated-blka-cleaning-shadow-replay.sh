#!/usr/bin/env bash
set -Eeuo pipefail

: "${EXPECTED_COMMIT:?EXPECTED_COMMIT is required}"
container=${RESTORE_CONTAINER:-wb-tender-restore-verify-20260828T211025Z-db}
database=${RESTORE_DATABASE:-wb_platform_restore}
database_user=${RESTORE_DATABASE_USER:-restore_admin}
root=$(git rev-parse --show-toplevel)
expected_tree=${EXPECTED_TREE:-}
document_version='5e885f85-c63e-47c8-ac5e-ab6770f9d446'
company_id='15c3c602-aa51-4dd4-adc1-3586dc82e523'

printf '===== SOURCE IDENTITY =====\n'
actual_commit=$(git -C "$root" rev-parse HEAD)
actual_tree=$(git -C "$root" rev-parse HEAD^{tree})
printf 'commit=%s\ntree=%s\n' "$actual_commit" "$actual_tree"
test "$actual_commit" = "$EXPECTED_COMMIT"
if [[ -n "$expected_tree" ]]; then test "$actual_tree" = "$expected_tree"; fi
test -z "$(git -C "$root" status --porcelain)"

printf '\n===== ISOLATED CLONE PREFLIGHT =====\n'
command -v node
command -v docker
test "$(docker inspect -f '{{.State.Running}}' "$container")" = true
published=$(docker inspect -f '{{range $port,$bindings := .NetworkSettings.Ports}}{{if $bindings}}{{$port}}={{json $bindings}}{{end}}{{end}}' "$container")
test -z "$published" || { printf 'ERROR: clone publishes host ports: %s\n' "$published" >&2; exit 65; }

fingerprint_sql="SELECT concat_ws('|',
 (SELECT count(*) FROM tender.tenders),
 (SELECT count(*) FROM tender.enrichment_documents),
 (SELECT count(*) FROM tender.enrichment_fields),
 (SELECT count(*) FROM tender.calculations),
 (SELECT count(*) FROM tender.region_evaluations),
 (SELECT count(*) FROM tender.configuration_active_parameters),
 (SELECT count(*) FROM tender.external_action_receipts),
 (SELECT count(*) FROM app.schema_migrations WHERE version='0155-c23-canonical-calculation-contract'))"
before=$(docker exec "$container" psql -U "$database_user" -d "$database" -X -At -v ON_ERROR_STOP=1 -c "$fingerprint_sql")
printf 'before_fingerprint=%s\n' "$before"

selected_lot_ids=$(docker exec "$container" psql -U "$database_user" -d "$database" -X -At -v ON_ERROR_STOP=1 -c "
SELECT id FROM tender.enrichment_lots
WHERE enrichment_version_id='$document_version'::uuid AND lot_key='LOT-0001'
ORDER BY id")
test "$(printf '%s\n' "$selected_lot_ids" | sed '/^$/d' | wc -l)" -eq 1 || {
  printf 'ERROR: exact LOT-0001 enrichment identity is not unique\n' >&2
  exit 66
}

approved_c22_c23=$(docker exec "$container" psql -U "$database_user" -d "$database" -X -At -v ON_ERROR_STOP=1 -c "
SELECT count(*)
FROM tender.configuration_active_parameters active
JOIN tender.configuration_changes change ON change.id=active.change_id
JOIN tender.configuration_versions version ON version.id=active.version_id
WHERE active.company_id='$company_id'::uuid
  AND active.service_line='cleaning'
  AND active.parameter_key IN('C22','C23')
  AND version.status='ACTIVE'
  AND version.approved_by IS NOT NULL
  AND version.approved_at IS NOT NULL
  AND change.valid_from<=current_date
  AND (change.valid_until IS NULL OR change.valid_until>=current_date)")
test "$approved_c22_c23" = 0 || {
  printf 'ERROR: clone parameter state drifted; approved C22/C23 rows=%s\n' "$approved_c22_c23" >&2
  exit 67
}

temporary=$(mktemp -d)
cleanup(){ rm -f "$temporary/documents.json"; rmdir "$temporary" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

docker exec "$container" psql -U "$database_user" -d "$database" -X -At -v ON_ERROR_STOP=1 -c "
SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id',id,
  'lot_id',lot_id,
  'filename',filename,
  'payload_sha256',payload_sha256,
  'procurement_verification_status',procurement_verification_status,
  'provenance',provenance,
  'extracted_data',extracted_data
) ORDER BY filename,id),'[]'::jsonb)::text
FROM tender.enrichment_documents
WHERE enrichment_version_id='$document_version'::uuid
  AND procurement_verification_status='VERIFIED'
  AND filename~*'preisblatt'
  AND filename~*'\\.(xlsx|ods)(\\.ods)?$'" >"$temporary/documents.json"

printf '\n===== EXACT READ-ONLY SHADOW RESULT =====\n'
node "$root/scripts/isolated-blka-cleaning-shadow.mjs" \
  "$temporary/documents.json" "$selected_lot_ids"

after=$(docker exec "$container" psql -U "$database_user" -d "$database" -X -At -v ON_ERROR_STOP=1 -c "$fingerprint_sql")
printf 'after_fingerprint=%s\n' "$after"
test "$before" = "$after" || { printf 'ERROR: protected clone fingerprint changed\n' >&2; exit 68; }

printf 'approved_C22_C23_rows=%s\n' "$approved_c22_c23"
printf 'shadow_status=CALCULATION_BLOCKED_MISSING_INPUT_C22_C23\n'
printf 'PASS: exact BLKA Cleaning shadow replay remained read-only and cross-lot isolated.\n'
