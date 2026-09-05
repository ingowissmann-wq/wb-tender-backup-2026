#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
root=$(git rev-parse --show-toplevel)
temporary=$(mktemp -d /tmp/wb-rollback-integration.XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT
mkdir "$temporary/bin"
printf 'postgresql://file-only\n' >"$temporary/database"
printf 'ROLLBACK_MIGRATION=155_autopilot_overview_latest_lookup.sql\nROLLBACK_MIGRATION=156_approved_tender_commercial_plans.sql\nROLLBACK_MIGRATION=157_release_auth_and_commercial_enforcement.sql\nROLLBACK_MIGRATION=158_tender_login_challenge_runtime_grants.sql\nROLLBACK_MIGRATION=159_runtime_request_scope.sql\n' >"$temporary/applied"
cat >"$temporary/bin/psql" <<'SH'
#!/usr/bin/env bash
input=$(cat)
printf '%s %s\n' "$*" "$input" >>"$PSQL_TEST_LOG"
[[ -z "${PSQL_FAIL_MATCH:-}" || "$* $input" != *"$PSQL_FAIL_MATCH"* ]]
SH
chmod 0755 "$temporary/bin/psql"
export PATH="$temporary/bin:$PATH" PSQL_TEST_LOG="$temporary/psql.log"
DATABASE_URL_FILE="$temporary/database" APPLIED_MIGRATIONS_FILE="$temporary/applied" RELEASE_ID="$(git rev-parse HEAD)" LEDGER_EXISTED_BEFORE=true SNAPSHOT_EXISTED_BEFORE=true "$root/deployment/rollback-applied-release-migrations.sh"
mapfile -t down < <(sed -n -e 's/.*-f \(migrations\/159_runtime_request_scope\.down\.sql\).*/\1/p' -e 's/.*-f \(migrations\/158_tender_login_challenge_runtime_grants\.down\.sql\).*/\1/p' -e 's/.*-f deployment\/\(rollback-[^ ]*\.sql\).*/\1/p' -e 's/.*\\i deployment\/\(rollback-[^ ]*\.sql\).*/\1/p' "$temporary/psql.log")
[[ "${down[*]}" == "migrations/159_runtime_request_scope.down.sql migrations/158_tender_login_challenge_runtime_grants.down.sql rollback-release-auth-and-commercial-enforcement.sql rollback-approved-tender-commercial-plans.sql rollback-autopilot-overview-latest-lookup.sql" ]]
: >"$temporary/psql.log"
set +e
PSQL_FAIL_MATCH=rollback-approved-tender-commercial-plans.sql DATABASE_URL_FILE="$temporary/database" APPLIED_MIGRATIONS_FILE="$temporary/applied" RELEASE_ID="$(git rev-parse HEAD)" LEDGER_EXISTED_BEFORE=true SNAPSHOT_EXISTED_BEFORE=true "$root/deployment/rollback-applied-release-migrations.sh"
status=$?
set -e
[[ "$status" -ne 0 ]]
! grep -q rollback-autopilot-overview-latest-lookup.sql "$temporary/psql.log"
printf '{"passed":true,"actualRollbackScriptExecuted":true,"reverseOrder":true,"failureInjectionFailClosed":true}\n'
