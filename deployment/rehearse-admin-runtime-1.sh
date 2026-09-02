#!/usr/bin/env bash
set -euo pipefail

export PAGER=cat
export GIT_PAGER=cat
export GIT_TERMINAL_PROMPT=0

ADMIN_IMAGE='wb-admin:internal-recovery-candidate.1'
ADMIN_IMAGE_ID='sha256:b0432f108955504b6cbd198999b9138d74ffdfba23a6ec32885fe45df1fd90b6'
PRODUCTION_API='wb-tender-production-api'
PRODUCTION_DB='wb-tender-production-db'
PRODUCTION_IMAGE_ID='sha256:30d64f6334519b095f4af837380ac7b56df6ff0c90fb3652a0c100f3528335e3'

BACKUP_DIR='/srv/wb-tender-production/rollback/global-region-14-20260902T141327Z'
BACKUP="${BACKUP_DIR}/wb_platform_restore.dump"
BACKUP_SHA256='e72de7f38e6ceffccf031d7229ee18763f879d20b3bdeab79fb778564d3898eaf'

ROOT='/srv/wb-tender-recovery/admin-runtime-rehearsal-1'
SECRETS="${ROOT}/secrets"
DATA="${ROOT}/data"
LOGS="${ROOT}/logs"

NETWORK='wb-admin-rehearsal-1'
DB_CONTAINER='wb-admin-rehearsal-db-1'
REDIS_CONTAINER='wb-admin-rehearsal-redis-1'
ADMIN_CONTAINER='wb-admin-rehearsal-api-1'
DB_VOLUME='wb-admin-rehearsal-db-1'

for CONTAINER in "${DB_CONTAINER}" "${REDIS_CONTAINER}" "${ADMIN_CONTAINER}"; do
  if docker container inspect "${CONTAINER}" >/dev/null 2>&1; then
    printf 'ABORT: rehearsal resource already exists: %s\n' "${CONTAINER}"
    exit 73
  fi
done

if docker network inspect "${NETWORK}" >/dev/null 2>&1; then
  printf 'ABORT: rehearsal network already exists: %s\n' "${NETWORK}"
  exit 73
fi

if docker volume inspect "${DB_VOLUME}" >/dev/null 2>&1; then
  printf 'ABORT: rehearsal volume already exists: %s\n' "${DB_VOLUME}"
  exit 73
fi

test ! -e "${ROOT}"
printf '%s\n' 'WB_REHEARSE_ADMIN_RUNTIME_1=STARTED'
printf '%s\n' '===== VERIFY PINNED BACKUP MANIFEST ====='

MANIFEST="${BACKUP_DIR}/prerollout-manifest.env"
BACKUP_SIZE_EXPECTED='25639262589'

test -s "${BACKUP}"
test -s "${BACKUP_DIR}/globals-no-passwords.sql"
test -s "${MANIFEST}"
test "$(stat --format='%s' "${BACKUP}")" = "${BACKUP_SIZE_EXPECTED}"
grep -Fxq "backup=${BACKUP}" "${MANIFEST}"
grep -Fxq "backup_size_bytes=${BACKUP_SIZE_EXPECTED}" "${MANIFEST}"
grep -Fxq "backup_sha256=${BACKUP_SHA256}" "${MANIFEST}"
printf 'backup_manifest=PASS size_bytes=%s previously_verified_sha256=%s\n' \
  "${BACKUP_SIZE_EXPECTED}" "${BACKUP_SHA256}"

test "$(docker image inspect --format '{{.Id}}' "${ADMIN_IMAGE}")" = "${ADMIN_IMAGE_ID}"
test "$(docker inspect --format '{{.State.Running}}' "${PRODUCTION_API}")" = 'true'
test "$(docker inspect --format '{{.State.Running}}' "${PRODUCTION_DB}")" = 'true'
test "$(docker inspect --format '{{.Image}}' "${PRODUCTION_API}")" = "${PRODUCTION_IMAGE_ID}"

PRODUCTION_HEALTH="$(
  curl --max-time 15 --silent --show-error --insecure     --resolve 'www.enwi.online:443:127.0.0.1'     --output /dev/null --write-out '%{http_code}'     https://www.enwi.online/healthz
)"
test "${PRODUCTION_HEALTH}" = '200'

SUBMISSION_ENV="$(
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${PRODUCTION_API}" |
    grep -Ei '^(EXTERNAL_SUBMISSION_ENABLED|PORTAL_SUBMISSION_ENABLED|SUBMISSION_ENABLED)='
)"
test -n "${SUBMISSION_ENV}"
! printf '%s\n' "${SUBMISSION_ENV}" | grep -Eiv '^[A-Z_]+=false$'

umask 077
install -d -m 0700 "${SECRETS}" "${DATA}" "${LOGS}" "${DATA}/private" "${DATA}/career-uploads"
openssl rand -hex 32 > "${SECRETS}/db_password"
openssl rand -hex 32 > "${SECRETS}/session_pepper"
openssl rand -hex 32 > "${SECRETS}/iam_field_key"
openssl rand -base64 48 | tr -d '\n' > "${SECRETS}/admin_bootstrap_password"
openssl rand -hex 32 > "${SECRETS}/admin_redis_password"
printf '%s\n' 'admin@wb-tender.de' > "${SECRETS}/owner_email"

AUTOSEO_TOKEN="$(openssl rand -hex 32)"
printf '{"token":"%s"}\n' "${AUTOSEO_TOKEN}" > "${SECRETS}/autoseo_webhook"
unset AUTOSEO_TOKEN

DB_PASSWORD="$(cat "${SECRETS}/db_password")"
printf 'postgresql://admin_rehearsal:%s@%s:5432/wb_platform\n'   "${DB_PASSWORD}" "${DB_CONTAINER}" > "${SECRETS}/database_url"
unset DB_PASSWORD
chmod 0400 "${SECRETS}"/*

ADMIN_UID="$(docker run --rm --network none --entrypoint id "${ADMIN_IMAGE}" -u)"
ADMIN_GID="$(docker run --rm --network none --entrypoint id "${ADMIN_IMAGE}" -g)"
chown -R "${ADMIN_UID}:${ADMIN_GID}" "${DATA}"

cleanup_on_error() {
  STATUS="$?"
  trap - ERR INT TERM
  set +e
  printf 'REHEARSAL_RECOVERY_STARTED status=%s\n' "${STATUS}"
  docker logs "${ADMIN_CONTAINER}" > "${LOGS}/admin.log" 2>&1 || true
  docker logs "${REDIS_CONTAINER}" > "${LOGS}/redis.log" 2>&1 || true
  docker logs "${DB_CONTAINER}" > "${LOGS}/database.log" 2>&1 || true
  docker rm -f "${ADMIN_CONTAINER}" "${REDIS_CONTAINER}" "${DB_CONTAINER}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK}" >/dev/null 2>&1 || true
  docker volume rm "${DB_VOLUME}" >/dev/null 2>&1 || true
  printf '%s\n' 'REHEARSAL_RECOVERY_COMPLETED'
  printf 'production_health=%s\n' "$(
    curl --max-time 15 --silent --insecure       --resolve 'www.enwi.online:443:127.0.0.1'       --output /dev/null --write-out '%{http_code}'       https://www.enwi.online/healthz 2>/dev/null || true
  )"
  exit "${STATUS}"
}
trap cleanup_on_error ERR INT TERM

printf '%s\n' '===== START ISOLATED DATABASE AND REDIS ====='
docker network create --internal "${NETWORK}" >/dev/null
docker volume create "${DB_VOLUME}" >/dev/null

docker run -d   --name "${DB_CONTAINER}"   --network "${NETWORK}"   --network-alias "${DB_CONTAINER}"   --volume "${DB_VOLUME}:/var/lib/postgresql/data"   --volume "${SECRETS}/db_password:/run/secrets/db_password:ro"   --volume "${BACKUP_DIR}:/verified-backup:ro"   --env POSTGRES_USER=admin_rehearsal   --env POSTGRES_DB=wb_platform   --env POSTGRES_PASSWORD_FILE=/run/secrets/db_password   postgres:16-alpine >/dev/null

for ATTEMPT in $(seq 1 120); do
  if docker exec "${DB_CONTAINER}" pg_isready       --username admin_rehearsal --dbname wb_platform >/dev/null 2>&1; then
    break
  fi
  test "${ATTEMPT}" != '120'
  sleep 2
done
printf '%s\n' 'isolated_database=ready'

REDIS_PASSWORD="$(cat "${SECRETS}/admin_redis_password")"
docker run -d   --name "${REDIS_CONTAINER}"   --network "${NETWORK}"   --network-alias admin-redis   redis:7-alpine   redis-server --save '' --appendonly no --requirepass "${REDIS_PASSWORD}" >/dev/null
unset REDIS_PASSWORD

for ATTEMPT in $(seq 1 60); do
  if docker exec "${REDIS_CONTAINER}" sh -euc       'redis-cli -a "$1" --no-auth-warning ping' sh       "$(cat "${SECRETS}/admin_redis_password")" 2>/dev/null |
      grep -Fxq PONG; then
    break
  fi
  test "${ATTEMPT}" != '60'
  sleep 1
done
printf '%s\n' 'isolated_redis=ready'

printf '%s\n' '===== RESTORE VERIFIED DATABASE CLONE ====='
printf '%s\n' 'restore_progress=started'

docker exec --interactive "${DB_CONTAINER}" sh -euc '
  export PGPASSWORD="$(cat /run/secrets/db_password)"
  psql --no-psqlrc --username admin_rehearsal --dbname postgres --file /verified-backup/globals-no-passwords.sql >/tmp/globals-restore.log 2>&1 || true
  pg_restore --exit-on-error --no-owner --no-acl --jobs=2 --username admin_rehearsal --dbname wb_platform /verified-backup/wb_platform_restore.dump
' > "${LOGS}/restore.log" 2>&1 &

RESTORE_PID="$!"
RESTORE_STARTED="$(date +%s)"

while kill -0 "${RESTORE_PID}" 2>/dev/null; do
  sleep 30
  if kill -0 "${RESTORE_PID}" 2>/dev/null; then
    RESTORE_ELAPSED="$(( $(date +%s) - RESTORE_STARTED ))"
    printf 'restore_progress=running elapsed_seconds=%s database_volume=%s\n' \
      "${RESTORE_ELAPSED}" \
      "$(docker system df -v 2>/dev/null | awk -v volume="${DB_VOLUME}" '$1==volume {print $3; found=1} END {if(!found)print "unknown"}')"
  fi
done

wait "${RESTORE_PID}"
printf '%s\n' 'restore_progress=complete'

CLONE_FINGERPRINT="$(
  docker exec "${DB_CONTAINER}" sh -euc '
    export PGPASSWORD="$(cat /run/secrets/db_password)"
    psql --no-psqlrc --tuples-only --no-align       --username admin_rehearsal --dbname wb_platform       --command "
        SELECT
          (SELECT count(*) FROM tender.tenders)
          ||chr(124)||
          (SELECT count(*) FROM tender.tender_lot_selections)
          ||chr(124)||
          (SELECT count(*) FROM iam.users);
      "
  ' |
  tr -d '[:space:]'
)"
test -n "${CLONE_FINGERPRINT}"
printf 'clone_fingerprint=tenders|lot_selections|iam_users=%s\n' "${CLONE_FINGERPRINT}"

printf '%s\n' '===== START ISOLATED ADMIN RUNTIME ====='
docker run -d   --name "${ADMIN_CONTAINER}"   --network "${NETWORK}"   --publish 127.0.0.1:4340:3400   --volume "${SECRETS}/database_url:/run/secrets/database_url:ro"   --volume "${SECRETS}/session_pepper:/run/secrets/session_pepper:ro"   --volume "${SECRETS}/iam_field_key:/run/secrets/iam_field_key:ro"   --volume "${SECRETS}/owner_email:/run/secrets/owner_email:ro"   --volume "${SECRETS}/admin_bootstrap_password:/run/secrets/admin_bootstrap_password:ro"   --volume "${SECRETS}/admin_redis_password:/run/secrets/admin_redis_password:ro"   --volume "${SECRETS}/autoseo_webhook:/run/secrets/autoseo_webhook:ro"   --volume "${DATA}:/data"   --env AUTOSEO_SECRET_FILE=/run/secrets/autoseo_webhook   --env AUTOSEO_PUBLIC_SITE_ORIGIN=https://www.wb-holding.ag   --env EXTERNAL_SUBMISSION_ENABLED=false   --env WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false   --env WB_ADMIN_SAAS_ENABLED=false   --env WB_ADMIN_TENANCY_ENFORCED=false   --env WB_ADMIN_TENANT_FILE_STORAGE_ENABLED=false   "${ADMIN_IMAGE}" >/dev/null

READY='false'
for ATTEMPT in $(seq 1 120); do
  HEALTH="$(
    curl --max-time 5 --silent --output /dev/null       --write-out '%{http_code}'       http://127.0.0.1:4340/api/healthz 2>/dev/null || true
  )"
  if test "${HEALTH}" = '200'; then
    READY='true'
    break
  fi
  if test $((ATTEMPT % 10)) -eq 0; then
    printf 'admin_runtime_wait=%s/120\n' "${ATTEMPT}"
  fi
  test "$(docker inspect --format '{{.State.Running}}' "${ADMIN_CONTAINER}")" = 'true'
  sleep 2
done
test "${READY}" = 'true'

printf '%s\n' '===== ISOLATED ADMIN HTTP CONTRACT ====='
for CONTRACT in   '/api/healthz|200'   '/admin/|200'   '/admin/index.html|200'   '/api/admin/v1/iam/me|401'
do
  PATHNAME="${CONTRACT%|*}"
  EXPECTED="${CONTRACT##*|}"
  ACTUAL="$(
    curl --max-time 10 --silent --output /dev/null       --write-out '%{http_code}'       "http://127.0.0.1:4340${PATHNAME}"
  )"
  printf '%s|expected=%s|actual=%s\n' "${PATHNAME}" "${EXPECTED}" "${ACTUAL}"
  test "${ACTUAL}" = "${EXPECTED}"
done

INDEX="$(curl --max-time 10 --silent --fail http://127.0.0.1:4340/admin/)"
printf '%s' "${INDEX}" | grep -Fq '<div id="root"></div>'

mapfile -t ASSETS < <(
  printf '%s' "${INDEX}" |
    grep -Eo '(src|href)="[^"]+"' |
    cut -d'"' -f2 |
    grep '^/admin/assets/' |
    sort -u
)
test "${#ASSETS[@]}" -gt 0
for ASSET in "${ASSETS[@]}"; do
  test "$(curl --max-time 10 --silent --output /dev/null     --write-out '%{http_code}' "http://127.0.0.1:4340${ASSET}")" = '200'
done
printf 'admin_static_assets=%s|all_200=true\n' "${#ASSETS[@]}"

ADMIN_ENV="$(
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${ADMIN_CONTAINER}"
)"
printf '%s\n' "${ADMIN_ENV}" | grep -Fxq 'EXTERNAL_SUBMISSION_ENABLED=false'
printf '%s\n' "${ADMIN_ENV}" | grep -Fxq 'WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false'
printf '%s\n' "${ADMIN_ENV}" | grep -Fxq 'WB_ADMIN_SAAS_ENABLED=false'
printf '%s\n' "${ADMIN_ENV}" | grep -Fxq 'WB_ADMIN_TENANCY_ENFORCED=false'
printf '%s\n' "${ADMIN_ENV}" | grep -Fxq 'WB_ADMIN_TENANT_FILE_STORAGE_ENABLED=false'

docker logs "${ADMIN_CONTAINER}" > "${LOGS}/admin.log" 2>&1
! grep -Eq 'FATAL|UnhandledPromiseRejection|EACCES|ECONNREFUSED' "${LOGS}/admin.log"

PRODUCTION_HEALTH_AFTER="$(
  curl --max-time 15 --silent --show-error --insecure     --resolve 'www.enwi.online:443:127.0.0.1'     --output /dev/null --write-out '%{http_code}'     https://www.enwi.online/healthz
)"
test "${PRODUCTION_HEALTH_AFTER}" = '200'
test "$(docker inspect --format '{{.Image}}' "${PRODUCTION_API}")" = "${PRODUCTION_IMAGE_ID}"

trap - ERR INT TERM

cat > "${ROOT}/rehearsal-result.env" <<RESULT
admin_candidate=${ADMIN_IMAGE}
admin_candidate_id=${ADMIN_IMAGE_ID}
clone_fingerprint=${CLONE_FINGERPRINT}
admin_health=200
admin_ui=200
admin_unauthenticated_gate=401
admin_assets_all_200=true
external_submission=false
saas_enabled=false
tenancy_enforced=false
tenant_file_storage_enabled=false
production_image=${PRODUCTION_IMAGE_ID}
production_health=200
production_changed=false
production_database_changed=false
RESULT
chmod 0400 "${ROOT}/rehearsal-result.env"

printf '%s\n' 'WB_REHEARSE_ADMIN_RUNTIME_1=SUCCESS'
printf 'admin_candidate_id=%s\n' "${ADMIN_IMAGE_ID}"
printf '%s\n' 'admin_health=200'
printf '%s\n' 'admin_ui=200'
printf '%s\n' 'admin_unauthenticated_gate=401'
printf 'admin_static_assets=%s|all_200=true\n' "${#ASSETS[@]}"
printf '%s\n' 'external_submission=false'
printf '%s\n' 'production_health=200'
printf '%s\n' 'production_changed=false'
printf '%s\n' 'production_database_changed=false'
printf 'rehearsal_root=%s\n' "${ROOT}"
