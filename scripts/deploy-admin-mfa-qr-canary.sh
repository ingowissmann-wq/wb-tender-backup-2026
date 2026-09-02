#!/usr/bin/env bash
set -Eeuo pipefail

CONTAINER="wb-admin-rehearsal-auth-1"
EXPECTED_IMAGE="sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86"
BASE_IMAGE="wb-phase4-platform:20260816-iam-mfa-network-roaming.1"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NEW_IMAGE="wb-admin:isolated-canary-mfa-qr-${STAMP}"
ROLLBACK_IMAGE="wb-admin:isolated-canary-before-mfa-qr-${STAMP}"
AUDIT_DIR="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/qr-release-${STAMP}"

test "$(id -u)" -eq 0
test "$(docker inspect "$CONTAINER" --format '{{.Image}}')" = "$EXPECTED_IMAGE"
test "$(docker inspect "$CONTAINER" --format '{{.State.Running}}')" = "true"
docker image inspect "$BASE_IMAGE" >/dev/null
command -v docker >/dev/null
docker compose version >/dev/null

PROJECT="$(docker inspect "$CONTAINER" --format '{{index .Config.Labels "com.docker.compose.project"}}')"
SERVICE="$(docker inspect "$CONTAINER" --format '{{index .Config.Labels "com.docker.compose.service"}}')"
WORKING_DIR="$(docker inspect "$CONTAINER" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')"
CONFIG_FILES="$(docker inspect "$CONTAINER" --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}')"

test -n "$PROJECT"
test -n "$SERVICE"
test -d "$WORKING_DIR"
test -n "$CONFIG_FILES"

mkdir -p "$AUDIT_DIR"
docker inspect "$CONTAINER" >"${AUDIT_DIR}/container-before.json"
docker tag "$EXPECTED_IMAGE" "$ROLLBACK_IMAGE"

COMPOSE_ARGS=(-p "$PROJECT")
IFS=',' read -r -a CONFIG_PATHS <<<"$CONFIG_FILES"
for CONFIG_PATH in "${CONFIG_PATHS[@]}"; do
  if [[ "$CONFIG_PATH" != /* ]]; then
    CONFIG_PATH="${WORKING_DIR}/${CONFIG_PATH}"
  fi
  test -f "$CONFIG_PATH"
  COMPOSE_ARGS+=(-f "$CONFIG_PATH")
done

cat >"${AUDIT_DIR}/compose-new.yml" <<YAML
services:
  ${SERVICE}:
    image: ${NEW_IMAGE}
YAML

cat >"${AUDIT_DIR}/compose-rollback.yml" <<YAML
services:
  ${SERVICE}:
    image: ${ROLLBACK_IMAGE}
YAML

docker compose "${COMPOSE_ARGS[@]}" -f "${AUDIT_DIR}/compose-new.yml" config >/dev/null
docker compose "${COMPOSE_ARGS[@]}" -f "${AUDIT_DIR}/compose-rollback.yml" config >/dev/null

node --test tests/admin-login-mfa-contract.test.mjs
docker build --pull=false \
  --file deployment/Dockerfile.admin-login-mfa-enrollment \
  --tag "$NEW_IMAGE" .

docker run --rm --network none --entrypoint node "$NEW_IMAGE" \
  --input-type=module -e 'await import("qrcode")'
docker run --rm --network none --entrypoint sh "$NEW_IMAGE" -c \
  'grep -Rql "src:R.qrDataUrl" /app/apps/admin/dist/assets/index-*.js && grep -Fq "QRCode.toDataURL" /app/apps/api/dist/server.js'

SWAPPED=false
rollback() {
  status=$?
  if test "$SWAPPED" = true; then
    docker compose "${COMPOSE_ARGS[@]}" -f "${AUDIT_DIR}/compose-rollback.yml" \
      up -d --no-deps --force-recreate "$SERVICE"
    printf '%s\n' "WB_ADMIN_QR_CANARY_ROLLBACK=SUCCESS"
  fi
  exit "$status"
}
trap rollback EXIT

SWAPPED=true
docker compose "${COMPOSE_ARGS[@]}" -f "${AUDIT_DIR}/compose-new.yml" \
  up -d --no-deps --force-recreate "$SERVICE"

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

NEW_IMAGE_ID="$(docker image inspect "$NEW_IMAGE" --format '{{.Id}}')"
test "$(docker inspect "$CONTAINER" --format '{{.Image}}')" = "$NEW_IMAGE_ID"
docker exec "$CONTAINER" sh -c \
  'grep -Rql "src:R.qrDataUrl" /app/apps/admin/dist/assets/index-*.js && grep -Fq "QRCode.toDataURL" /app/apps/api/dist/server.js'
test "$(curl -ksS -o /dev/null -w '%{http_code}' https://www.enwi.online/admin/)" = 200

SWAPPED=false
trap - EXIT
docker inspect "$CONTAINER" >"${AUDIT_DIR}/container-after.json"

printf '%s\n' "WB_ADMIN_QR_CANARY_DEPLOY=SUCCESS"
printf '%s\n' "container=${CONTAINER}"
printf '%s\n' "image=${NEW_IMAGE_ID}"
printf '%s\n' "rollback_image=${ROLLBACK_IMAGE}"
printf '%s\n' "audit_directory=${AUDIT_DIR}"
printf '%s\n' "production_changed=false"
printf '%s\n' "production_mfa_changed=false"
printf '%s\n' "external_submission_changed=false"
