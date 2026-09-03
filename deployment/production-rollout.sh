#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

required=(COMPOSE_FILE RELEASE_IMAGE PREVIOUS_IMAGE DATABASE_URL_FILE BACKUP_DIR REHEARSAL_EVIDENCE OPERATOR_APPROVAL)
for name in "${required[@]}"; do [[ -n "${!name:-}" ]] || { echo "missing required environment: $name" >&2; exit 64; }; done
[[ "$RELEASE_IMAGE" == *@sha256:* ]] || { echo "RELEASE_IMAGE must be digest pinned" >&2; exit 64; }
[[ "$PREVIOUS_IMAGE" == *@sha256:* ]] || { echo "PREVIOUS_IMAGE must be digest pinned" >&2; exit 64; }
[[ "$BACKUP_DIR" = /* && "$BACKUP_DIR" != "$(git rev-parse --show-toplevel)"* ]] || { echo "BACKUP_DIR must be absolute and outside checkout" >&2; exit 64; }
for file in "$COMPOSE_FILE" "$DATABASE_URL_FILE" "$REHEARSAL_EVIDENCE" "$OPERATOR_APPROVAL"; do [[ -r "$file" ]] || { echo "required operator file is unreadable: $file" >&2; exit 66; }; done
commit=$(git rev-parse HEAD)
[[ -z "$(git status --porcelain)" ]] || { echo "checkout is not clean" >&2; exit 65; }
grep -qx "COMMIT=$commit" "$REHEARSAL_EVIDENCE" || { echo "rehearsal evidence is not for this commit" >&2; exit 65; }
grep -qx 'RESULT=PASS' "$REHEARSAL_EVIDENCE" || { echo "rehearsal has not passed" >&2; exit 65; }
grep -qx "APPROVE_COMMIT=$commit" "$OPERATOR_APPROVAL" || { echo "separate operator approval is missing" >&2; exit 65; }

project=wb-tender-rollout
export RELEASE_IMAGE EXTERNAL_SUBMISSION_ENABLED=false WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false
mkdir -p "$BACKUP_DIR"
backup="$BACKUP_DIR/wb-tender-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose -p "$project" -f "$COMPOSE_FILE" exec -T db sh -c 'pg_dump -Fc "$POSTGRES_DB"' >"$backup"
[[ -s "$backup" ]] || { echo "backup was not created" >&2; exit 74; }

rollback() {
  status=$?; trap - ERR INT TERM
  RELEASE_IMAGE="$PREVIOUS_IMAGE" docker compose -p "$project" -f "$COMPOSE_FILE" up -d --no-deps --force-recreate api worker scheduler || true
  docker compose -p "$project" -f "$COMPOSE_FILE" run --rm -T -v "$DATABASE_URL_FILE:/run/secrets/database_url:ro" -e DATABASE_URL_FILE=/run/secrets/database_url -e RELEASE_ID="$commit" tools sh -c "psql \"\$(cat \"\$DATABASE_URL_FILE\")\" -v ON_ERROR_STOP=1 -c \"SET wb.release_id='$commit'\" -f deployment/rollback-approved-tender-commercial-plans.sql" || true
  exit "$status"
}
trap rollback ERR INT TERM
docker compose -p "$project" -f "$COMPOSE_FILE" run --rm -T -v "$DATABASE_URL_FILE:/run/secrets/database_url:ro" -e DATABASE_URL_FILE=/run/secrets/database_url -e RELEASE_ID="$commit" tools deployment/apply-release-migrations.sh
docker compose -p "$project" -f "$COMPOSE_FILE" up -d --no-deps --force-recreate api worker scheduler
for service in api worker scheduler; do
  id=$(docker compose -p "$project" -f "$COMPOSE_FILE" ps -q "$service"); test -n "$id"
  [[ "$(docker inspect "$id" --format '{{.Config.Image}}')" == "$RELEASE_IMAGE" ]]
done
docker compose -p "$project" -f "$COMPOSE_FILE" exec -T api node tests/production-gate.mjs
trap - ERR INT TERM
echo "rollout complete for $commit; backup retained at $backup"
