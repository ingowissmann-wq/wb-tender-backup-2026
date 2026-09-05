#!/usr/bin/env bash
set -Eeuo pipefail
project=$1 compose=$2 release_id=$3
rollback() {
  trap - ERR
  docker compose -p "$project" -f "$compose" exec -T db psql -U postgres -v ON_ERROR_STOP=1 -d wb_rehearsal < migrations/158_tender_login_challenge_runtime_grants.down.sql
  docker compose -p "$project" -f "$compose" exec -T db psql -U postgres -v ON_ERROR_STOP=1 -d wb_rehearsal < deployment/rollback-release-auth-and-commercial-enforcement.sql
  { printf "SET wb.release_id='%s';\n" "$release_id"; cat deployment/rollback-approved-tender-commercial-plans.sql; } | docker compose -p "$project" -f "$compose" exec -T db psql -U postgres -v ON_ERROR_STOP=1 -d wb_rehearsal
  docker compose -p "$project" -f "$compose" exec -T db psql -U postgres -v ON_ERROR_STOP=1 -d wb_rehearsal < deployment/rollback-autopilot-overview-latest-lookup.sql
  docker compose -p "$project" -f "$compose" exec -T db psql -U postgres -v ON_ERROR_STOP=1 -d wb_rehearsal -c "DELETE FROM tender.release_migrations WHERE name IN ('155_autopilot_overview_latest_lookup.sql','156_approved_tender_commercial_plans.sql','157_release_auth_and_commercial_enforcement.sql','158_tender_login_challenge_runtime_grants.sql')"
  exit 0
}
trap rollback ERR
[[ "${REHEARSAL_FORCE_FAILURE:-}" != after_migrations ]] || false
echo "rollback probe did not trigger" >&2
exit 70
