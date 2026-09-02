#!/usr/bin/env bash
set -euo pipefail

ADMIN_IMAGE='wb-admin:internal-recovery-candidate.2'
ADMIN_IMAGE_ID='sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86'
ROOT='/srv/wb-tender-recovery/admin-runtime-rehearsal-4'
SECRETS="${ROOT}/secrets"
DATA="${ROOT}/data"
LOGS="${ROOT}/logs"

INTERNAL_NETWORK='wb-admin-rehearsal-1'
DB_CONTAINER='wb-admin-rehearsal-db-1'
REDIS_CONTAINER='wb-admin-rehearsal-redis-1'
ADMIN_CONTAINER='wb-admin-rehearsal-api-1'

PRODUCTION_API='wb-tender-production-api'
PRODUCTION_IMAGE_ID='sha256:30d64f6334519b095f4af837380ac7b56df6ff0c90fb3652a0c100f3528335e3'

printf '%s\n' 'WB_RESUME_ADMIN_RUNTIME_REHEARSAL_2=STARTED'

test -d "${ROOT}"
test -d "${SECRETS}"
test -d "${DATA}"
test -d "${LOGS}"
test "$(docker image inspect --format '{{.Id}}' "${ADMIN_IMAGE}")" = "${ADMIN_IMAGE_ID}"
test "$(docker inspect --format '{{.State.Running}}' "${DB_CONTAINER}")" = 'true'
test "$(docker inspect --format '{{.State.Running}}' "${REDIS_CONTAINER}")" = 'true'
docker network inspect "${INTERNAL_NETWORK}" >/dev/null

if docker container inspect "${ADMIN_CONTAINER}" >/dev/null 2>&1; then
  printf '%s\n' 'ABORT: isolated admin container already exists'
  exit 73
fi

for SECRET in database_url session_pepper iam_field_key owner_email admin_bootstrap_password admin_redis_password autoseo_webhook; do
  test -s "${SECRETS}/${SECRET}"
done

test "$(docker inspect --format '{{.Image}}' "${PRODUCTION_API}")" = "${PRODUCTION_IMAGE_ID}"
test "$(docker inspect --format '{{.State.Running}}' "${PRODUCTION_API}")" = 'true'

PRODUCTION_HEALTH="$(
  curl --max-time 15 --silent --show-error --insecure     --resolve 'www.enwi.online:443:127.0.0.1'     --output /dev/null --write-out '%{http_code}'     https://www.enwi.online/healthz
)"
test "${PRODUCTION_HEALTH}" = '200'

cleanup_on_error() {
  STATUS="$?"
  trap - ERR INT TERM
  set +e
  docker logs "${ADMIN_CONTAINER}" > "${LOGS}/admin-resume.log" 2>&1 || true
  docker rm -f "${ADMIN_CONTAINER}" >/dev/null 2>&1 || true
  printf 'ADMIN_REHEARSAL_RESUME_FAILED status=%s\n' "${STATUS}"
  printf '%s\n' 'isolated_restore_preserved=true'
  printf 'production_health=%s\n' "$(
    curl --max-time 15 --silent --insecure       --resolve 'www.enwi.online:443:127.0.0.1'       --output /dev/null --write-out '%{http_code}'       https://www.enwi.online/healthz 2>/dev/null || true
  )"
  exit "${STATUS}"
}
trap cleanup_on_error ERR INT TERM

printf '%s\n' '===== CREATE DUAL-NETWORK ADMIN CANARY ====='

docker create   --name "${ADMIN_CONTAINER}"   --network bridge   --publish 127.0.0.1:4340:3400   --volume "${SECRETS}/database_url:/run/secrets/database_url:ro"   --volume "${SECRETS}/session_pepper:/run/secrets/session_pepper:ro"   --volume "${SECRETS}/iam_field_key:/run/secrets/iam_field_key:ro"   --volume "${SECRETS}/owner_email:/run/secrets/owner_email:ro"   --volume "${SECRETS}/admin_bootstrap_password:/run/secrets/admin_bootstrap_password:ro"   --volume "${SECRETS}/admin_redis_password:/run/secrets/admin_redis_password:ro"   --volume "${SECRETS}/autoseo_webhook:/run/secrets/autoseo_webhook:ro"   --volume "${DATA}:/data"   --env AUTOSEO_SECRET_FILE=/run/secrets/autoseo_webhook   --env AUTOSEO_PUBLIC_SITE_ORIGIN=https://www.wb-holding.ag   --env EXTERNAL_SUBMISSION_ENABLED=false   --env WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false   --env WB_ADMIN_SAAS_ENABLED=false   --env WB_ADMIN_TENANCY_ENFORCED=false   --env WB_ADMIN_TENANT_FILE_STORAGE_ENABLED=false   "${ADMIN_IMAGE}" >/dev/null

docker network connect "${INTERNAL_NETWORK}" "${ADMIN_CONTAINER}"
docker start "${ADMIN_CONTAINER}" >/dev/null

READY='false'
for ATTEMPT in $(seq 1 90); do
  HOST_CODE="$(
    curl --max-time 5 --silent --output /dev/null       --write-out '%{http_code}'       http://127.0.0.1:4340/api/healthz 2>/dev/null || true
  )"
  CONTAINER_HEALTH="$(
    docker inspect --format       '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'       "${ADMIN_CONTAINER}" 2>/dev/null || true
  )"

  if test "${HOST_CODE}" = '200' &&
     { test "${CONTAINER_HEALTH}" = 'healthy' || test "${CONTAINER_HEALTH}" = 'none'; }; then
    READY='true'
    break
  fi

  if test $((ATTEMPT % 10)) -eq 0; then
    printf 'admin_canary_wait=%s/90 host_http=%s container_health=%s\n'       "${ATTEMPT}" "${HOST_CODE}" "${CONTAINER_HEALTH}"
  fi

  test "$(docker inspect --format '{{.State.Running}}' "${ADMIN_CONTAINER}")" = 'true'
  sleep 2
done
test "${READY}" = 'true'

printf '%s\n' '===== ISOLATED ADMIN HTTP CONTRACT ====='

for CONTRACT in '/api/healthz|200' '/admin/|200' '/admin/index.html|200' '/api/admin/v1/iam/me|401'; do
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
  CODE="$(
    curl --max-time 10 --silent --output /dev/null       --write-out '%{http_code}'       "http://127.0.0.1:4340${ASSET}"
  )"
  test "${CODE}" = '200'
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

docker logs "${ADMIN_CONTAINER}" > "${LOGS}/admin-resume.log" 2>&1
! grep -Eq 'ERR_MODULE_NOT_FOUND|FATAL|UnhandledPromiseRejection|EACCES|ECONNREFUSED' "${LOGS}/admin-resume.log"

test "$(docker inspect --format '{{.Image}}' "${PRODUCTION_API}")" = "${PRODUCTION_IMAGE_ID}"
PRODUCTION_HEALTH_AFTER="$(
  curl --max-time 15 --silent --show-error --insecure     --resolve 'www.enwi.online:443:127.0.0.1'     --output /dev/null --write-out '%{http_code}'     https://www.enwi.online/healthz
)"
test "${PRODUCTION_HEALTH_AFTER}" = '200'

trap - ERR INT TERM

cat > "${ROOT}/rehearsal-result.env" <<RESULT
admin_candidate=${ADMIN_IMAGE}
admin_candidate_id=${ADMIN_IMAGE_ID}
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
isolated_restore_preserved=true
RESULT
chmod 0400 "${ROOT}/rehearsal-result.env"

printf '%s\n' 'WB_RESUME_ADMIN_RUNTIME_REHEARSAL_2=SUCCESS'
printf 'admin_candidate_id=%s\n' "${ADMIN_IMAGE_ID}"
printf '%s\n' 'admin_health=200'
printf '%s\n' 'admin_ui=200'
printf '%s\n' 'admin_unauthenticated_gate=401'
printf 'admin_static_assets=%s|all_200=true\n' "${#ASSETS[@]}"
printf '%s\n' 'external_submission=false'
printf '%s\n' 'production_health=200'
printf '%s\n' 'production_changed=false'
printf '%s\n' 'production_database_changed=false'
printf '%s\n' 'isolated_restore_preserved=true'
printf '%s\n' 'isolated_admin_canary_running=true'
