#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
required=(REHEARSAL_COMPOSE_FILE RELEASE_IMAGE DATABASE_URL_FILE SOURCE_DUMP E2E_AUTH_FILE EVIDENCE_FILE)
for name in "${required[@]}"; do [[ -n "${!name:-}" ]] || { echo "missing required environment: $name" >&2; exit 64; }; done
[[ "$RELEASE_IMAGE" == *@sha256:* ]] || { echo "RELEASE_IMAGE must be digest pinned" >&2; exit 64; }
for file in "$REHEARSAL_COMPOSE_FILE" "$DATABASE_URL_FILE" "$SOURCE_DUMP" "$E2E_AUTH_FILE"; do [[ -r "$file" ]] || { echo "required rehearsal file is unreadable: $file" >&2; exit 66; }; done
command -v docker >/dev/null || { echo "docker is required" >&2; exit 69; }
commit=$(git rev-parse HEAD); project="wb-tender-rehearsal-${commit:0:12}"
cleanup() { docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
export RELEASE_IMAGE EXTERNAL_SUBMISSION_ENABLED=false WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" up -d db
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db pg_restore --exit-on-error --clean --if-exists --no-owner -d postgres <"$SOURCE_DUMP"
before=$(docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db psql -At -d postgres -c "SELECT md5(coalesce(jsonb_agg(to_jsonb(p) ORDER BY code)::text,'')) FROM saas.plans p WHERE code IN ('CORE','NORMAL','PROFESSIONAL','ENTERPRISE')")
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" run --rm -T -v "$DATABASE_URL_FILE:/run/secrets/database_url:ro" -e DATABASE_URL_FILE=/run/secrets/database_url -e RELEASE_ID="$commit" tools deployment/apply-release-migrations.sh
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" up -d api worker scheduler
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" run --rm -T -v "$E2E_AUTH_FILE:/run/secrets/e2e_auth:ro" -e E2E_AUTH_FILE=/run/secrets/e2e_auth browser node scripts/release-browser-e2e.mjs
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db psql -v ON_ERROR_STOP=1 -d postgres -c "SET wb.release_id='$commit'" -f /app/deployment/rollback-approved-tender-commercial-plans.sql
after=$(docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db psql -At -d postgres -c "SELECT md5(coalesce(jsonb_agg(to_jsonb(p) ORDER BY code)::text,'')) FROM saas.plans p WHERE code IN ('CORE','NORMAL','PROFESSIONAL','ENTERPRISE')")
[[ "$before" == "$after" ]] || { echo "rollback did not restore exact plan rows" >&2; exit 1; }
printf 'COMMIT=%s\nRESULT=PASS\nPLAN_ROWS_SHA256=%s\n' "$commit" "$(printf %s "$after" | sha256sum | cut -d' ' -f1)" >"$EVIDENCE_FILE"
