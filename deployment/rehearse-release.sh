#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
required=(RELEASE_IMAGE POSTGRES_IMAGE BROWSER_IMAGE DATABASE_URL_FILE SOURCE_DUMP E2E_AUTH_FILE SESSION_PEPPER_FILE EVIDENCE_FILE)
for name in "${required[@]}"; do [[ -n "${!name:-}" ]] || { echo "missing required environment: $name" >&2; exit 64; }; done
for name in RELEASE_IMAGE POSTGRES_IMAGE BROWSER_IMAGE; do [[ "${!name}" == *@sha256:* ]] || { echo "$name must be digest pinned" >&2; exit 64; }; done
REHEARSAL_COMPOSE_FILE=${REHEARSAL_COMPOSE_FILE:-deployment/compose.rehearsal.yml}
for file in "$REHEARSAL_COMPOSE_FILE" "$DATABASE_URL_FILE" "$SOURCE_DUMP" "$E2E_AUTH_FILE" "$SESSION_PEPPER_FILE"; do [[ -r "$file" ]] || { echo "required rehearsal file is unreadable: $file" >&2; exit 66; }; done
command -v docker >/dev/null || { echo "docker is required" >&2; exit 69; }
commit=$(git rev-parse HEAD); project="wb-tender-rehearsal-${commit:0:12}"
cleanup() { docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
export RELEASE_IMAGE POSTGRES_IMAGE BROWSER_IMAGE DATABASE_URL_FILE E2E_AUTH_FILE SESSION_PEPPER_FILE EXTERNAL_SUBMISSION_ENABLED=false WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" up -d db
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db sh -c 'until pg_isready -U postgres -d wb_rehearsal; do sleep 1; done'
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db pg_restore --exit-on-error --clean --if-exists --no-owner -d wb_rehearsal <"$SOURCE_DUMP"
before=$(docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db psql -At -d wb_rehearsal -c "SELECT md5(coalesce(jsonb_agg(to_jsonb(p) ORDER BY code)::text,'')) FROM saas.plans p WHERE code IN ('CORE','NORMAL','PROFESSIONAL','ENTERPRISE')")
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" run --rm -T -v "$DATABASE_URL_FILE:/run/secrets/database_url:ro" -e DATABASE_URL_FILE=/run/secrets/database_url -e RELEASE_ID="$commit" tools deployment/apply-release-migrations.sh
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" up -d api worker scheduler
for service in api worker scheduler; do
  id=$(docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" ps -q "$service"); [[ -n "$id" ]]
  [[ "$(docker inspect "$id" --format '{{.Image}}')" == "$(docker image inspect "$RELEASE_IMAGE" --format '{{.Id}}')" ]] || { echo "runtime image mismatch: $service" >&2; exit 1; }
done
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" up --wait --wait-timeout 120 api
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" run --rm -T browser node scripts/release-browser-e2e.mjs
# Deliberately enter the rollout error path. The probe is successful only when
# the rollback handler restores data, indexes and the migration ledger.
REHEARSAL_FORCE_FAILURE=after_migrations deployment/rehearsal/rollback-probe.sh "$project" "$REHEARSAL_COMPOSE_FILE" "$commit"
after=$(docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db psql -At -d wb_rehearsal -c "SELECT md5(coalesce(jsonb_agg(to_jsonb(p) ORDER BY code)::text,'')) FROM saas.plans p WHERE code IN ('CORE','NORMAL','PROFESSIONAL','ENTERPRISE')")
[[ "$before" == "$after" ]] || { echo "rollback did not restore exact plan rows" >&2; exit 1; }
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db psql -At -d wb_rehearsal -c "SELECT count(*) FROM tender.release_migrations WHERE name IN ('155_autopilot_overview_latest_lookup.sql','156_approved_tender_commercial_plans.sql')" | grep -qx 0
printf 'COMMIT=%s\nRESULT=PASS\nPLAN_ROWS_SHA256=%s\n' "$commit" "$(printf %s "$after" | sha256sum | cut -d' ' -f1)" >"$EVIDENCE_FILE"
