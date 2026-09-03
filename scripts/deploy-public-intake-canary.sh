#!/usr/bin/env bash
set -Eeuo pipefail

C=wb-admin-rehearsal-auth-1
EXPECTED_IMAGE='sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86'
SERVER_PATH=/app/apps/api/dist/server.js
PATCHER="$(cd "$(dirname "$0")/.." && pwd)/integrations/wb-admin-portal/candidate/public-intake-patch.mjs"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/public-intake-${STAMP}"

mkdir -p "$WORK"
test -f "$PATCHER"
test "$(docker inspect "$C" --format '{{.State.Running}}')" = true
test "$(docker inspect "$C" --format '{{.Image}}')" = "$EXPECTED_IMAGE"
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4341/api/healthz)" = 200

docker cp "$C:$SERVER_PATH" "$WORK/server.before.js"
cp -a "$WORK/server.before.js" "$WORK/server.patched.js"

docker run --rm --network none --user 0:0 \
  -v "$WORK:/work" \
  -v "$PATCHER:/patch/public-intake-patch.mjs:ro" \
  --entrypoint node "$EXPECTED_IMAGE" \
  /patch/public-intake-patch.mjs /work/server.patched.js

grep -Fq 'WB_PUBLIC_INTAKE_V1' "$WORK/server.patched.js"
docker run --rm --network none --user 0:0 \
  -v "$WORK:/work:ro" --entrypoint node "$EXPECTED_IMAGE" \
  --check /work/server.patched.js

PATCHED=false
rollback() {
  status=$?
  if test "$PATCHED" = true; then
    docker cp "$WORK/server.before.js" "$C:$SERVER_PATH" >/dev/null
    docker restart "$C" >/dev/null
    for _ in $(seq 1 30); do
      test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4341/api/healthz || true)" = 200 && break
      sleep 1
    done
    printf '%s\n' 'WB_PUBLIC_INTAKE_ROLLBACK=SUCCESS'
  fi
  exit "$status"
}
trap rollback ERR

docker cp "$WORK/server.patched.js" "$C:$SERVER_PATH"
PATCHED=true
docker restart "$C" >/dev/null

HEALTH=false
for _ in $(seq 1 30); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4341/api/healthz || true)
  if test "$code" = 200; then HEALTH=true; break; fi
  sleep 1
done
test "$HEALTH" = true

GET_CODE=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4341/api/public/v1/services)
APPLICATION_VALIDATION=$(curl -sS -o /dev/null -w '%{http_code}' \
  -H 'content-type: application/json' -d '{}' \
  http://127.0.0.1:4341/api/public/v1/applications)
CONTACT_VALIDATION=$(curl -sS -o /dev/null -w '%{http_code}' \
  -H 'content-type: application/json' -d '{}' \
  http://127.0.0.1:4341/api/public/v1/contact-submissions)

test "$GET_CODE" = 200
test "$APPLICATION_VALIDATION" = 422
test "$CONTACT_VALIDATION" = 422

PATCHED=false
trap - ERR
printf '%s\n' 'WB_PUBLIC_INTAKE_CANARY=SUCCESS'
printf 'backup_directory=%s\n' "$WORK"
printf '%s\n' 'test_records_created=false'
printf '%s\n' 'production_database_changed=false'
printf '%s\n' 'production_mfa_changed=false'
printf '%s\n' 'external_submission_changed=false'
