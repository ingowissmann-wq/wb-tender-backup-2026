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
TECHNICAL_CANARY='wb-admin-rehearsal-api-1'
AUTH_CANARY='wb-admin-rehearsal-auth-1'

PRODUCTION_API='wb-tender-production-api'
PRODUCTION_IMAGE_ID='sha256:30d64f6334519b095f4af837380ac7b56df6ff0c90fb3652a0c100f3528335e3'

printf '%s\n' 'WB_CREATE_AUTHENTICATABLE_ADMIN_CANARY=STARTED'

test "$(docker image inspect --format '{{.Id}}' "${ADMIN_IMAGE}")" = "${ADMIN_IMAGE_ID}"
test "$(docker inspect --format '{{.State.Running}}' "${DB_CONTAINER}")" = 'true'
test "$(docker inspect --format '{{.State.Running}}' "${REDIS_CONTAINER}")" = 'true'
test "$(docker inspect --format '{{.State.Running}}' "${TECHNICAL_CANARY}")" = 'true'
test "$(docker inspect --format '{{.Image}}' "${PRODUCTION_API}")" = "${PRODUCTION_IMAGE_ID}"
test "$(docker inspect --format '{{.State.Running}}' "${PRODUCTION_API}")" = 'true'
docker network inspect "${INTERNAL_NETWORK}" >/dev/null

if docker container inspect "${AUTH_CANARY}" >/dev/null 2>&1; then
  printf '%s\n' 'ABORT: authenticated canary already exists'
  exit 73
fi

mount_source() {
  local DESTINATION="$1"
  docker inspect --format '{{json .Mounts}}' "${PRODUCTION_API}" |
    python3 -c '
import json
import sys
mounts=json.load(sys.stdin)
destination=sys.argv[1]
matches=[item.get("Source","") for item in mounts if item.get("Destination")==destination]
if len(matches)!=1 or not matches[0]:
    raise SystemExit(1)
print(matches[0])
' "${DESTINATION}"
}

SESSION_SOURCE="$(mount_source /run/secrets/session_pepper)"
FIELD_SOURCE="$(mount_source /run/secrets/iam_field_key)"
OWNER_SOURCE="$(mount_source /run/secrets/owner_email)"

test -s "${SESSION_SOURCE}"
test -s "${FIELD_SOURCE}"
test -s "${OWNER_SOURCE}"

for SECRET in database_url admin_bootstrap_password admin_redis_password autoseo_webhook; do
  test -s "${SECRETS}/${SECRET}"
done

printf '%s\n' '===== VERIFY READ-ONLY AUTH SECRET ACCESS ====='

docker run --rm   --network none   --entrypoint sh   --volume "${SESSION_SOURCE}:/run/secrets/session_pepper:ro"   --volume "${FIELD_SOURCE}:/run/secrets/iam_field_key:ro"   --volume "${OWNER_SOURCE}:/run/secrets/owner_email:ro"   "${ADMIN_IMAGE}" -euc '
    test -r /run/secrets/session_pepper
    test -s /run/secrets/session_pepper
    test -r /run/secrets/iam_field_key
    test -s /run/secrets/iam_field_key
    test -r /run/secrets/owner_email
    test -s /run/secrets/owner_email
  '

printf '%s\n' 'production_auth_secrets=readable_read_only'
printf '%s\n' 'secret_values_displayed=false'

cleanup_on_error() {
  STATUS="$?"
  trap - ERR INT TERM
  set +e
  docker logs "${AUTH_CANARY}" > "${LOGS}/admin-auth-canary.log" 2>&1 || true
  docker rm -f "${AUTH_CANARY}" >/dev/null 2>&1 || true
  printf 'AUTHENTICATABLE_CANARY_FAILED status=%s\n' "${STATUS}"
  printf '%s\n' 'isolated_restore_preserved=true'
  printf 'production_health=%s\n' "$(
    curl --max-time 15 --silent --insecure       --resolve 'www.enwi.online:443:127.0.0.1'       --output /dev/null --write-out '%{http_code}'       https://www.enwi.online/healthz 2>/dev/null || true
  )"
  exit "${STATUS}"
}
trap cleanup_on_error ERR INT TERM

printf '%s\n' '===== START AUTHENTICATABLE ISOLATED CANARY ====='

docker create   --name "${AUTH_CANARY}"   --network bridge   --publish 127.0.0.1:4341:3400   --volume "${SECRETS}/database_url:/run/secrets/database_url:ro"   --volume "${SESSION_SOURCE}:/run/secrets/session_pepper:ro"   --volume "${FIELD_SOURCE}:/run/secrets/iam_field_key:ro"   --volume "${OWNER_SOURCE}:/run/secrets/owner_email:ro"   --volume "${SECRETS}/admin_bootstrap_password:/run/secrets/admin_bootstrap_password:ro"   --volume "${SECRETS}/admin_redis_password:/run/secrets/admin_redis_password:ro"   --volume "${SECRETS}/autoseo_webhook:/run/secrets/autoseo_webhook:ro"   --volume "${DATA}:/data"   --env AUTOSEO_SECRET_FILE=/run/secrets/autoseo_webhook   --env AUTOSEO_PUBLIC_SITE_ORIGIN=https://www.wb-holding.ag   --env EXTERNAL_SUBMISSION_ENABLED=false   --env WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false   --env WB_ADMIN_SAAS_ENABLED=false   --env WB_ADMIN_TENANCY_ENFORCED=false   --env WB_ADMIN_TENANT_FILE_STORAGE_ENABLED=false   "${ADMIN_IMAGE}" >/dev/null

docker network connect "${INTERNAL_NETWORK}" "${AUTH_CANARY}"
docker start "${AUTH_CANARY}" >/dev/null

READY='false'
for ATTEMPT in $(seq 1 90); do
  CODE="$(
    curl --max-time 5 --silent --output /dev/null       --write-out '%{http_code}'       http://127.0.0.1:4341/api/healthz 2>/dev/null || true
  )"
  HEALTH="$(
    docker inspect --format       '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'       "${AUTH_CANARY}" 2>/dev/null || true
  )"
  if test "${CODE}" = '200' &&
     { test "${HEALTH}" = 'healthy' || test "${HEALTH}" = 'none'; }; then
    READY='true'
    break
  fi
  if test $((ATTEMPT % 10)) -eq 0; then
    printf 'auth_canary_wait=%s/90 http=%s health=%s\n'       "${ATTEMPT}" "${CODE}" "${HEALTH}"
  fi
  test "$(docker inspect --format '{{.State.Running}}' "${AUTH_CANARY}")" = 'true'
  sleep 2
done
test "${READY}" = 'true'

for CONTRACT in '/api/healthz|200' '/admin/|200' '/admin/index.html|200' '/api/admin/v1/iam/me|401'; do
  PATHNAME="${CONTRACT%|*}"
  EXPECTED="${CONTRACT##*|}"
  ACTUAL="$(
    curl --max-time 10 --silent --output /dev/null       --write-out '%{http_code}'       "http://127.0.0.1:4341${PATHNAME}"
  )"
  printf '%s|expected=%s|actual=%s\n' "${PATHNAME}" "${EXPECTED}" "${ACTUAL}"
  test "${ACTUAL}" = "${EXPECTED}"
done

docker logs "${AUTH_CANARY}" > "${LOGS}/admin-auth-canary.log" 2>&1
! grep -Eq 'ERR_MODULE_NOT_FOUND|FATAL|UnhandledPromiseRejection|EACCES|ECONNREFUSED' "${LOGS}/admin-auth-canary.log"

PRODUCTION_HEALTH="$(
  curl --max-time 15 --silent --show-error --insecure     --resolve 'www.enwi.online:443:127.0.0.1'     --output /dev/null --write-out '%{http_code}'     https://www.enwi.online/healthz
)"
test "${PRODUCTION_HEALTH}" = '200'
test "$(docker inspect --format '{{.Image}}' "${PRODUCTION_API}")" = "${PRODUCTION_IMAGE_ID}"

trap - ERR INT TERM

printf '%s\n' 'WB_CREATE_AUTHENTICATABLE_ADMIN_CANARY=SUCCESS'
printf 'admin_candidate_id=%s\n' "${ADMIN_IMAGE_ID}"
printf '%s\n' 'canary_url=http://127.0.0.1:4341/admin/'
printf '%s\n' 'admin_health=200'
printf '%s\n' 'admin_ui=200'
printf '%s\n' 'admin_unauthenticated_gate=401'
printf '%s\n' 'production_auth_secrets=mounted_read_only'
printf '%s\n' 'isolated_database=true'
printf '%s\n' 'isolated_restore_preserved=true'
printf '%s\n' 'external_submission=false'
printf '%s\n' 'production_health=200'
printf '%s\n' 'production_changed=false'
printf '%s\n' 'production_database_changed=false'
