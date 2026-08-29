#!/usr/bin/env bash
set -Eeuo pipefail

: "${EXPECTED_COMMIT:?EXPECTED_COMMIT is required}"

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
database=${RESTORE_DATABASE:-wb_platform_restore}
database_user=${RESTORE_DATABASE_USER:-restore_admin}
up="$root/migrations/155_c23_canonical_calculation_contract.sql"
down="$root/migrations/155_c23_canonical_calculation_contract.down.sql"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

scalar() {
  docker exec "$container" psql -U "$database_user" -d "$database" -X -A -t -v ON_ERROR_STOP=1 -c "$1"
}

fingerprint() {
  scalar "SELECT jsonb_build_object(
    'tenders',(SELECT count(*) FROM tender.tenders),
    'documents',(SELECT count(*) FROM tender.enrichment_documents),
    'packages',(SELECT count(*) FROM tender.bid_packages),
    'calculations',(SELECT count(*) FROM tender.calculations),
    'configurationScopes',(SELECT count(*) FROM tender.configuration_scopes),
    'configurationVersions',(SELECT count(*) FROM tender.configuration_versions),
    'configurationChanges',(SELECT count(*) FROM tender.configuration_changes),
    'configurationActiveParameters',(SELECT count(*) FROM tender.configuration_active_parameters),
    'c23Changes',(SELECT count(*) FROM tender.configuration_changes WHERE parameter_key='C23'),
    'c23Active',(SELECT count(*) FROM tender.configuration_active_parameters WHERE parameter_key='C23'),
    'externalActionReceipts',(SELECT count(*) FROM tender.external_action_receipts),
    'rlsMissing',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname IN('tender','crm','recruiting','tenant_portal','saas') AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attname='tenant_id') AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity))
  )::text"
}

assert_scalar() {
  local expected=$1
  local sql=$2
  local label=$3
  local actual
  actual=$(scalar "$sql")
  test "$actual" = "$expected" || fail "$label: expected=$expected actual=$actual"
}

assert_fingerprint() {
  local phase=$1
  local actual
  actual=$(fingerprint)
  test "$actual" = "$baseline" || fail "$phase changed protected data: baseline=$baseline actual=$actual"
  printf '%s fingerprint=%s\n' "$phase" "$actual"
}

printf '===== SOURCE IDENTITY =====\n'
test -d "$root/.git" || fail "source is not a Git checkout: $root"
actual_commit=$(git -C "$root" rev-parse HEAD)
test "$actual_commit" = "$EXPECTED_COMMIT" || fail "source commit mismatch: expected=$EXPECTED_COMMIT actual=$actual_commit"
test -z "$(git -C "$root" status --porcelain)" || fail "source checkout is dirty"
printf 'commit=%s\ntree=%s\n' "$actual_commit" "$(git -C "$root" rev-parse HEAD^{tree})"
printf '%s  %s\n' '818accad458e2de152038a547152200cb598f51d309a335bb20bb16e65953e49' "$up" | sha256sum --check
printf '%s  %s\n' '75090eabb791ebc622d0b4c484e75ad8046a7161a638140438345461fe626df3' "$down" | sha256sum --check

printf '\n===== ISOLATED RESTORE TARGET =====\n'
mapfile -t containers < <(docker ps --format '{{.Names}}' | awk '/^wb-tender-restore-verify-[0-9]{8}T[0-9]{6}Z-db$/')
test "${#containers[@]}" -eq 1 || fail "expected exactly one running isolated restore container, found ${#containers[@]}"
container=${containers[0]}
published=$(docker inspect -f '{{range $port,$bindings := .NetworkSettings.Ports}}{{if $bindings}}{{$port}}={{json $bindings}}{{end}}{{end}}' "$container")
test -z "$published" || fail "restore container publishes host ports: $published"
docker inspect -f 'container={{.Name}} image={{.Config.Image}} networks={{range $name,$value := .NetworkSettings.Networks}}{{$name}} {{end}}mounts={{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}} {{end}}' "$container"
assert_scalar '1' "SELECT CASE WHEN current_database()='$database' AND current_user='$database_user' THEN 1 ELSE 0 END" 'restore database identity'

printf '\n===== BASELINE GATES =====\n'
assert_scalar '1' "SELECT count(*) FROM app.schema_migrations WHERE version='0154-phase2-company-scoped-resolver-jobs'" 'required ledger head'
assert_scalar '154' "SELECT max(substring(version from '^([0-9]+)')::int) FROM app.schema_migrations WHERE version ~ '^[0-9]+'" 'maximum migration number'
assert_scalar '0' "SELECT count(*) FROM app.schema_migrations WHERE version IN('0155-c23-canonical-calculation-contract','0155-c23-canonical-calculation-contract-down')" 'migration 155 ledger must be absent'
assert_scalar '2' "SELECT count(*) FROM iam.roles WHERE code IN('administrator','calculation')" 'required roles'
assert_scalar '0' "SELECT count(*) FROM iam.permissions WHERE code='tender.calculation.sandbox'" 'sandbox permission must be absent before rehearsal'
baseline=$(fingerprint)
printf 'baseline fingerprint=%s\n' "$baseline"

printf '\n===== APPLY UP =====\n'
docker exec -i "$container" psql -U "$database_user" -d "$database" -X -v ON_ERROR_STOP=1 -f - < "$up"
assert_fingerprint 'after_up'
assert_scalar '1' "SELECT count(*) FROM iam.permissions WHERE code='tender.calculation.sandbox'" 'up permission'
assert_scalar '2' "SELECT count(*) FROM iam.role_permissions binding JOIN iam.permissions permission_row ON permission_row.id=binding.permission_id JOIN iam.roles role_row ON role_row.id=binding.role_id WHERE permission_row.code='tender.calculation.sandbox' AND role_row.code IN('administrator','calculation')" 'up role bindings'
assert_scalar '1' "SELECT count(*) FROM app.schema_migrations WHERE version='0155-c23-canonical-calculation-contract'" 'up ledger'

printf '\n===== APPLY DOWN =====\n'
docker exec -i "$container" psql -U "$database_user" -d "$database" -X -v ON_ERROR_STOP=1 -f - < "$down"
assert_fingerprint 'after_down'
assert_scalar '0' "SELECT count(*) FROM iam.permissions WHERE code='tender.calculation.sandbox'" 'down permission removal'
assert_scalar '0' "SELECT count(*) FROM app.schema_migrations WHERE version IN('0155-c23-canonical-calculation-contract','0155-c23-canonical-calculation-contract-down')" 'down ledger cleanup'

printf '\n===== REAPPLY UP =====\n'
docker exec -i "$container" psql -U "$database_user" -d "$database" -X -v ON_ERROR_STOP=1 -f - < "$up"
assert_fingerprint 'after_reapply'
assert_scalar '1' "SELECT count(*) FROM iam.permissions WHERE code='tender.calculation.sandbox'" 'final permission'
assert_scalar '2' "SELECT count(*) FROM iam.role_permissions binding JOIN iam.permissions permission_row ON permission_row.id=binding.permission_id JOIN iam.roles role_row ON role_row.id=binding.role_id WHERE permission_row.code='tender.calculation.sandbox' AND role_row.code IN('administrator','calculation')" 'final role bindings'
assert_scalar '1' "SELECT count(*) FROM app.schema_migrations WHERE version='0155-c23-canonical-calculation-contract'" 'final ledger'

printf '\nPASS: migration 155 up/down/up rehearsal completed only in the isolated clone; protected data remained identical and the clone is retained in candidate state.\n'
