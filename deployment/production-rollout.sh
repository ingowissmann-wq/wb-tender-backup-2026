#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Operator-driven only. Known non-secret production object names are defaults;
# credentials are discovered in memory from existing container metadata and
# are never printed or committed.
API_CONTAINER=${API_CONTAINER:-wb-tender-production-api}
WORKER_CONTAINER=${WORKER_CONTAINER:-wb-tender-production-worker}
SCHEDULER_CONTAINER=${SCHEDULER_CONTAINER:-wb-tender-production-scheduler}
DB_CONTAINER=${DB_CONTAINER:-wb-tender-production-db}
REHEARSAL_DB_CONTAINER=${REHEARSAL_DB_CONTAINER:-wb-admin-rehearsal-db-1}
PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-https://www.enwi.online}
PREVIOUS_IMAGE=${PREVIOUS_IMAGE:-sha256:30d64f6334519b095f4af837380ac7b56df6ff0c90fb3652a0c100f3528335e3}
CANDIDATE_IMAGE=${CANDIDATE_IMAGE:-wb-tender:tender-pilot-repair-candidate.25}
CANDIDATE_IMAGE_ID=${CANDIDATE_IMAGE_ID:-sha256:71a7de5d82499727e98026b64030eb7de57c4a63eeff11027efa885d89f39671}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/wb-tender}
COMPOSE_FILE=${COMPOSE_FILE:-$(docker inspect "$API_CONTAINER" --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}')}
RELEASE_IMAGE=${RELEASE_IMAGE:-wb-tender:commit-$(git rev-parse --short=12 HEAD)}
required=(RELEASE_IMAGE PREVIOUS_IMAGE COMPOSE_FILE PUBLIC_BASE_URL BACKUP_DIR)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || { echo "missing required environment: $name" >&2; exit 64; }
done
[[ -r "$COMPOSE_FILE" ]] || { echo "discovered Compose file is unreadable" >&2; exit 66; }
[[ "$PUBLIC_BASE_URL" == https://* ]] || { echo "PUBLIC_BASE_URL must use HTTPS" >&2; exit 64; }
command -v docker >/dev/null && command -v psql >/dev/null && command -v pg_dump >/dev/null && command -v curl >/dev/null || { echo "docker, psql, pg_dump and curl are required" >&2; exit 69; }

for container in "$API_CONTAINER" "$WORKER_CONTAINER" "$SCHEDULER_CONTAINER" "$DB_CONTAINER" "$REHEARSAL_DB_CONTAINER"; do docker inspect "$container" >/dev/null; done
[[ "$(docker image inspect "$CANDIDATE_IMAGE" --format '{{.Id}}')" == "$CANDIDATE_IMAGE_ID" ]] || { echo "candidate 25 image identity mismatch" >&2; exit 65; }
commit=$(git rev-parse HEAD)
[[ -z "$(git status --porcelain)" ]] || { echo "checkout is not clean" >&2; exit 65; }
docker build --pull=false --build-arg RELEASE_VERSION="$commit" --build-arg SOURCE_FINGERPRINT="$commit" -t "$RELEASE_IMAGE" -f Dockerfile.release .
release_id=$(docker image inspect "$RELEASE_IMAGE" --format '{{.Id}}')
database_url=$(docker inspect "$API_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^DATABASE_URL=//p')
[[ -n "$database_url" ]] || { echo "DATABASE_URL not discoverable from production API metadata" >&2; exit 65; }
admin_url=${database_url//$DB_CONTAINER/$REHEARSAL_DB_CONTAINER}

stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BACKUP_DIR"
backup="$BACKUP_DIR/wb-tender-$stamp.dump"
production_database=$(docker inspect "$DB_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_DB=//p')
[[ -n "$production_database" ]] || production_database=postgres
docker exec "$DB_CONTAINER" pg_dump --format=custom --file=/tmp/wb-tender-rollout.dump "$production_database"
docker cp "$DB_CONTAINER":/tmp/wb-tender-rollout.dump "$backup"
docker exec "$DB_CONTAINER" rm -f /tmp/wb-tender-rollout.dump
[[ -s "$backup" ]] || { echo "fresh backup was not created" >&2; exit 74; }

scratch="wb_tender_migration_${stamp//[^0-9]/}"
cleanup_scratch() { dropdb --if-exists --force --maintenance-db="$admin_url" "$scratch" >/dev/null 2>&1 || true; }
cleanup_canary() { docker rm -f wb-tender-canary-api wb-tender-canary-worker wb-tender-canary-scheduler >/dev/null 2>&1 || true; [[ -z "${canary_database_file:-}" ]] || rm -f "$canary_database_file"; }
rollback() {
  status=$?
  trap - ERR INT TERM
  echo "rollout failed; restoring all three services to the previous digest" >&2
  RELEASE_IMAGE="$PREVIOUS_IMAGE" EXTERNAL_SUBMISSION_ENABLED=false WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false \
    docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate api worker scheduler || true
  psql "$database_url" -v ON_ERROR_STOP=1 -f deployment/rollback-approved-tender-commercial-plans.sql >/dev/null || true
  psql "$database_url" -v ON_ERROR_STOP=1 -f deployment/rollback-autopilot-overview-latest-lookup.sql >/dev/null || true
  cleanup_scratch
  cleanup_canary
  exit "$status"
}
trap rollback ERR INT TERM
trap 'cleanup_canary; cleanup_scratch' EXIT

createdb --maintenance-db="$admin_url" --template=template0 "$scratch"
pg_restore --exit-on-error --no-owner --no-privileges --dbname="${admin_url%/*}/$scratch" "$backup"
for migration in migrations/*.sql; do psql "${admin_url%/*}/$scratch" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null; done
psql "${admin_url%/*}/$scratch" -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null
# Migrations 155/156 are the release delta. Earlier migrations belong to the
# already proven baseline and are rehearsed above, never blindly replayed on
# production.
# The isolated canary contract is delegated to the repository browser harness;
# it must use the rehearsal database and must complete before production can be
# touched. Cookie/credential material remains in operator-owned files.
canary_database_url="${admin_url%/*}/$scratch"
canary_database_file=$(mktemp)
chmod 600 "$canary_database_file"
printf '%s' "$canary_database_url" >"$canary_database_file"
RELEASE_IMAGE="$RELEASE_IMAGE" docker compose -f "$COMPOSE_FILE" run -d --no-deps --name wb-tender-canary-api -p 127.0.0.1:14240:4240 -e DATABASE_URL="$canary_database_url" -e EXTERNAL_SUBMISSION_ENABLED=false -e WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false api
RELEASE_IMAGE="$RELEASE_IMAGE" docker compose -f "$COMPOSE_FILE" run -d --no-deps --name wb-tender-canary-worker -e DATABASE_URL="$canary_database_url" -e EXTERNAL_SUBMISSION_ENABLED=false -e WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false worker
RELEASE_IMAGE="$RELEASE_IMAGE" docker compose -f "$COMPOSE_FILE" run -d --no-deps --name wb-tender-canary-scheduler -e DATABASE_URL="$canary_database_url" -e EXTERNAL_SUBMISSION_ENABLED=false -e WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false scheduler
for container in wb-tender-canary-api wb-tender-canary-worker wb-tender-canary-scheduler; do [[ "$(docker inspect "$container" --format '{{.Image}}')" == "$release_id" ]]; done
PERF_BASE_URL="http://127.0.0.1:14240" PERF_DATABASE_URL_FILE="$canary_database_file" PERF_COOKIE_FILE="${PERF_COOKIE_FILE:-/run/wb-tender/canary-cookie}" node scripts/autopilot-overview-performance.mjs
rm -f "$canary_database_file"
node tests/production-gate.mjs
printf 'Type the exact commit %s to switch production: ' "$commit" >&2
read -r approval
[[ "$approval" == "$commit" ]] || { echo "acceptance gate declined" >&2; false; }
psql "$database_url" -v ON_ERROR_STOP=1 -f migrations/155_autopilot_overview_latest_lookup.sql >/dev/null
psql "$database_url" -v ON_ERROR_STOP=1 -f migrations/156_approved_tender_commercial_plans.sql >/dev/null
RELEASE_IMAGE="$RELEASE_IMAGE" EXTERNAL_SUBMISSION_ENABLED=false WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false \
  docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate api worker scheduler

for service in api worker scheduler; do
  actual=$(docker inspect "$(docker compose -f "$COMPOSE_FILE" ps -q "$service")" --format '{{.Image}}')
  expected=$(docker image inspect "$RELEASE_IMAGE" --format '{{.Id}}')
  [[ "$actual" == "$expected" ]] || { echo "$service does not run the release image" >&2; false; }
done
curl --fail --silent --show-error "$PUBLIC_BASE_URL/api/tender/healthz" >/dev/null
for path in /admin/ausschreibungen /admin/ausschreibungen/; do
  code=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$PUBLIC_BASE_URL$path")
  [[ "$code" == 200 || "$code" == 302 || "$code" == 303 || "$code" == 307 ]] || { echo "$path returned $code" >&2; false; }
done
for service in api worker scheduler; do
  docker inspect "$(docker compose -f "$COMPOSE_FILE" ps -q "$service")" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -qx 'EXTERNAL_SUBMISSION_ENABLED=false'
  docker inspect "$(docker compose -f "$COMPOSE_FILE" ps -q "$service")" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -qx 'WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false'
done
psql "$database_url" -v ON_ERROR_STOP=1 -Atc "SELECT (NOT external_submission_enabled) AND (NOT allow_external_submission) AND global_kill_switch FROM tender.submission_runtime_settings WHERE singleton" | grep -qx t
trap - ERR INT TERM
echo "rollout complete: $RELEASE_IMAGE (backup: $backup)"
