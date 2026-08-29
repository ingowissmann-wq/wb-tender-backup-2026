#!/usr/bin/env bash
set -Eeuo pipefail

: "${EXPECTED_COMMIT:?EXPECTED_COMMIT is required}"
container=${RESTORE_CONTAINER:-wb-tender-restore-verify-20260828T211025Z-db}
database=${RESTORE_DATABASE:-wb_platform_restore}
database_user=${RESTORE_DATABASE_USER:-restore_admin}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(git -C "$script_dir/.." rev-parse --show-toplevel)

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
scalar() {
  docker exec "$container" psql -U "$database_user" -d "$database" -X -A -t -v ON_ERROR_STOP=1 -c "$1"
}
protected_fingerprint() {
  scalar "SELECT concat_ws('|',
    (SELECT count(*) FROM tender.tenders),
    (SELECT count(*) FROM tender.enrichment_documents),
    (SELECT count(*) FROM tender.enrichment_fields),
    (SELECT count(*) FROM tender.calculations),
    (SELECT count(*) FROM tender.management_outputs),
    (SELECT count(*) FROM tender.calculation_input_snapshots),
    (SELECT count(*) FROM tender.configuration_active_parameters),
    (SELECT count(*) FROM tender.external_action_receipts)
  )"
}

test "$(git -C "$root" rev-parse HEAD)" = "$EXPECTED_COMMIT" || fail "source commit mismatch"
test -z "$(git -C "$root" status --porcelain)" || fail "source checkout is dirty"
test "$database" = wb_platform_restore || fail "refusing non-restore database"
test "$(docker inspect -f '{{.State.Running}}' "$container")" = true || fail "isolated clone is not running"
published=$(docker inspect -f '{{range $port,$bindings := .NetworkSettings.Ports}}{{if $bindings}}{{$port}}={{json $bindings}}{{end}}{{end}}' "$container")
test -z "$published" || fail "isolated clone publishes host ports"
test "$(scalar "SELECT count(*) FROM app.schema_migrations WHERE version='0156-c11-hourly-material-contract'")" = 0 || fail "migration 156 is already present; refusing to replay an unknown partial state"

before=$(protected_fingerprint)
printf '===== MIGRATION 156 UP-DOWN-UP IN ISOLATED CLONE =====\n'
docker exec -i "$container" psql -U "$database_user" -d "$database" -X -v ON_ERROR_STOP=1 <"$root/migrations/156_c11_hourly_material_contract.sql"
test "$(scalar "SELECT count(*) FROM app.schema_migrations WHERE version='0156-c11-hourly-material-contract'")" = 1 || fail "migration 156 up failed"
docker exec -i "$container" psql -U "$database_user" -d "$database" -X -v ON_ERROR_STOP=1 <"$root/migrations/156_c11_hourly_material_contract.down.sql"
test "$(scalar "SELECT count(*) FROM app.schema_migrations WHERE version='0156-c11-hourly-material-contract'")" = 0 || fail "migration 156 down failed"
docker exec -i "$container" psql -U "$database_user" -d "$database" -X -v ON_ERROR_STOP=1 <"$root/migrations/156_c11_hourly_material_contract.sql"
test "$(scalar "SELECT count(*) FROM app.schema_migrations WHERE version='0156-c11-hourly-material-contract'")" = 1 || fail "migration 156 reapply failed"
after_migration=$(protected_fingerprint)
test "$after_migration" = "$before" || fail "protected fingerprint changed during migration rehearsal"

printf '\n===== EXACT APPROVED C11 ACTIVATION =====\n'
EXPECTED_COMMIT="$EXPECTED_COMMIT" "$root/scripts/isolated-c11-wb-cleaning-approved-activation.sh"

printf '\n===== EXACT READ-ONLY MUNICH REGRESSION =====\n'
EXPECTED_COMMIT="$EXPECTED_COMMIT" EXPECTED_TREE="$(git -C "$root" rev-parse 'HEAD^{tree}')" \
  "$root/scripts/isolated-munich-cleaning-shadow-replay.sh"

printf 'PASS: migration 156, exact WB-Cleaning C11 activation and the Munich calculation were rehearsed only in the isolated clone.\n'
