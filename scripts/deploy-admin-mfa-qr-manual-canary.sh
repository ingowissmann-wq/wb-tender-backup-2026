#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "$REPOSITORY_ROOT"

CONTAINER="wb-admin-rehearsal-auth-1"
EXPECTED_IMAGE="sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BUILD_BASE_IMAGE="wb-admin:isolated-canary-mfa-qr-base-${STAMP}"
NEW_IMAGE="wb-admin:isolated-canary-mfa-qr-${STAMP}"
STAGING_CONTAINER="wb-admin-mfa-qr-staging-${STAMP}"
AUDIT_DIR="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/qr-manual-release-${STAMP}"
ORIGINAL_DIR="${AUDIT_DIR}/original"
PATCHED_DIR="${AUDIT_DIR}/patched"

test "$(id -u)" -eq 0
test "$(docker inspect "$CONTAINER" --format '{{.Image}}')" = "$EXPECTED_IMAGE"
test "$(docker inspect "$CONTAINER" --format '{{.State.Running}}')" = "true"

mkdir -p "$ORIGINAL_DIR" "$PATCHED_DIR"
docker inspect "$CONTAINER" >"${AUDIT_DIR}/container-before.json"
docker cp "${CONTAINER}:/app/apps/api/dist/server.js" "${ORIGINAL_DIR}/server.js"
docker cp "${CONTAINER}:/app/apps/admin/dist" "${ORIGINAL_DIR}/admin-dist"
docker tag "$EXPECTED_IMAGE" "$BUILD_BASE_IMAGE"

node --test tests/admin-mfa-qr-patch.test.mjs
docker build --pull=false \
  --build-arg "BASE_IMAGE=${BUILD_BASE_IMAGE}" \
  --file deployment/Dockerfile.admin-mfa-qr-canary \
  --tag "$NEW_IMAGE" .

docker run --rm --network none --user 0 --entrypoint node "$NEW_IMAGE" \
  --input-type=module -e 'await import("qrcode")'
docker run --rm --network none --user 0 --entrypoint sh "$NEW_IMAGE" -c \
  'grep -Rql "src:R.qrDataUrl" /app/apps/admin/dist/assets/index-*.js && grep -Fq "QRCode.toDataURL" /app/apps/api/dist/server.js'

docker create --user 0 --name "$STAGING_CONTAINER" "$NEW_IMAGE" >/dev/null
docker cp "${STAGING_CONTAINER}:/app/apps/api/dist/server.js" "${PATCHED_DIR}/server.js"
docker cp "${STAGING_CONTAINER}:/app/apps/admin/dist" "${PATCHED_DIR}/admin-dist"
docker rm "$STAGING_CONTAINER" >/dev/null
STAGING_CONTAINER=""

test -s "${PATCHED_DIR}/server.js"
test -s "${PATCHED_DIR}/admin-dist/index.html"
grep -Fq "QRCode.toDataURL" "${PATCHED_DIR}/server.js"
grep -Rql "src:R.qrDataUrl" "${PATCHED_DIR}/admin-dist/assets"/index-*.js

SWAPPED=false
rollback() {
  status=$?
  if test -n "$STAGING_CONTAINER"; then
    docker rm -f "$STAGING_CONTAINER" >/dev/null 2>&1 || true
  fi
  if test "$SWAPPED" = true; then
    docker stop "$CONTAINER" >/dev/null 2>&1 || true
    docker cp "${ORIGINAL_DIR}/server.js" "${CONTAINER}:/app/apps/api/dist/server.js"
    docker cp "${ORIGINAL_DIR}/admin-dist/." "${CONTAINER}:/app/apps/admin/dist/"
    docker start "$CONTAINER" >/dev/null
    printf '%s\n' "WB_ADMIN_QR_MANUAL_CANARY_ROLLBACK=SUCCESS"
  fi
  exit "$status"
}
trap rollback EXIT

SWAPPED=true
docker stop "$CONTAINER" >/dev/null
docker cp "${PATCHED_DIR}/server.js" "${CONTAINER}:/app/apps/api/dist/server.js"
docker cp "${PATCHED_DIR}/admin-dist/." "${CONTAINER}:/app/apps/admin/dist/"
docker start "$CONTAINER" >/dev/null

HEALTHY=false
for attempt in $(seq 1 30); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4341/api/healthz || true)"
  printf '%s\n' "attempt=${attempt} health=${code}"
  if test "$code" = 200; then
    HEALTHY=true
    break
  fi
  sleep 1
done
test "$HEALTHY" = true

docker exec "$CONTAINER" sh -c \
  'grep -Rql "src:R.qrDataUrl" /app/apps/admin/dist/assets/index-*.js && grep -Fq "QRCode.toDataURL" /app/apps/api/dist/server.js'
test "$(curl -ksS -o /dev/null -w '%{http_code}' https://www.enwi.online/admin/)" = 200

SWAPPED=false
trap - EXIT
docker inspect "$CONTAINER" >"${AUDIT_DIR}/container-after.json"

printf '%s\n' "WB_ADMIN_QR_MANUAL_CANARY_DEPLOY=SUCCESS"
printf '%s\n' "container=${CONTAINER}"
printf '%s\n' "built_image=$(docker image inspect "$NEW_IMAGE" --format '{{.Id}}')"
printf '%s\n' "backup_directory=${ORIGINAL_DIR}"
printf '%s\n' "production_changed=false"
printf '%s\n' "production_mfa_changed=false"
printf '%s\n' "external_submission_changed=false"
