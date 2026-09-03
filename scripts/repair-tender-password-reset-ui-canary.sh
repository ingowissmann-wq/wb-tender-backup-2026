#!/usr/bin/env bash
set -Eeuo pipefail

C=wb-admin-rehearsal-auth-1
EXPECTED_IMAGE='sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86'
SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/tender-password-reset-${STAMP}"
ORIGINAL="${WORK}/owner-auth.before.mjs"
PATCHED="${WORK}/owner-auth.patched.mjs"
TARGET=/app/platform/owner-auth.mjs
PATCHER="${SOURCE}/integrations/wb-admin-portal/candidate/tender-password-reset-ui-patch.mjs"

mkdir -p "$WORK"
test "$(docker inspect "$C" --format '{{.State.Running}}')" = true
test "$(docker inspect "$C" --format '{{.Image}}')" = "$EXPECTED_IMAGE"
test -f "$PATCHER"

docker run --rm --network none --user 0:0 \
  -v "$SOURCE:/source:ro" \
  --entrypoint node "$EXPECTED_IMAGE" \
  --test /source/tests/tender-password-reset-ui.test.mjs

FORGOT_CODE=$(curl --http1.1 -ksS -o "$WORK/forgot-preflight.json" -w '%{http_code}' \
  --resolve www.enwi.online:443:127.0.0.1 \
  -H 'content-type: application/json' \
  --data '{"email":"nonexistent-reset-preflight@invalid.example"}' \
  'https://www.enwi.online/api/admin/v1/iam/password/forgot')
test "$FORGOT_CODE" = 200
grep -Fq '"ok":true' "$WORK/forgot-preflight.json"
printf '%s\n' 'preflight=password_reset_api_ok'

docker cp "$C:$TARGET" "$ORIGINAL"
cp -a "$ORIGINAL" "$PATCHED"

docker run --rm --network none --user 0:0 \
  -v "$PATCHER:/tmp/tender-password-reset-ui-patch.mjs:ro" \
  -v "$PATCHED:/tmp/owner-auth.mjs" \
  --entrypoint node "$EXPECTED_IMAGE" \
  /tmp/tender-password-reset-ui-patch.mjs /tmp/owner-auth.mjs

grep -Fq 'WB_TENDER_PASSWORD_RESET_UI' "$PATCHED"
grep -Fq '/api/admin/v1/iam/password/forgot' "$PATCHED"

docker cp "$PATCHED" "$C:/tmp/owner-auth.patched.mjs"
docker exec "$C" node --check /tmp/owner-auth.patched.mjs

APPLIED=false
rollback() {
  status=$?
  trap - ERR
  if test "$APPLIED" = true; then
    docker cp "$ORIGINAL" "$C:$TARGET" >/dev/null || true
    docker restart "$C" >/dev/null || true
    printf '%s\n' 'WB_TENDER_PASSWORD_RESET_ROLLBACK=SUCCESS' >&2
  fi
  exit "$status"
}
trap rollback ERR

docker exec --user 0:0 "$C" cp /tmp/owner-auth.patched.mjs "$TARGET"
APPLIED=true
docker restart "$C" >/dev/null

HEALTH=false
for ATTEMPT in $(seq 1 30); do
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4341/api/healthz || true)
  printf 'attempt=%s health=%s\n' "$ATTEMPT" "$CODE"
  if test "$CODE" = 200; then HEALTH=true; break; fi
  sleep 1
done
test "$HEALTH" = true

LOGIN_FILE="$WORK/login.html"
AUTH_FILE="$WORK/auth.js"
test "$(curl --http1.1 -ksS -o "$LOGIN_FILE" -w '%{http_code}' \
  --resolve www.enwi.online:443:127.0.0.1 \
  'https://www.enwi.online/admin/ausschreibungen/login')" = 200
test "$(curl --http1.1 -ksS -o "$AUTH_FILE" -w '%{http_code}' \
  --resolve www.enwi.online:443:127.0.0.1 \
  'https://www.enwi.online/admin/ausschreibungen/auth.js')" = 200
grep -Fq 'Passwort vergessen?' "$LOGIN_FILE"
grep -Fq 'WB_TENDER_PASSWORD_RESET_UI' "$AUTH_FILE"
grep -Fq '/api/admin/v1/iam/password/forgot' "$AUTH_FILE"

POST_CODE=$(curl --http1.1 -ksS -o "$WORK/forgot-postdeploy.json" -w '%{http_code}' \
  --resolve www.enwi.online:443:127.0.0.1 \
  -H 'content-type: application/json' \
  --data '{"email":"nonexistent-reset-postdeploy@invalid.example"}' \
  'https://www.enwi.online/api/admin/v1/iam/password/forgot')
test "$POST_CODE" = 200
grep -Fq '"ok":true' "$WORK/forgot-postdeploy.json"

APPLIED=false
trap - ERR
printf '%s\n' 'WB_TENDER_PASSWORD_RESET_UI=SUCCESS'
printf '%s\n' 'login_link=visible'
printf '%s\n' 'reset_request_api=200'
printf '%s\n' 'reset_link_validity=30_minutes_single_use'
printf 'backup=%s\n' "$ORIGINAL"
printf '%s\n' 'password_changed=false'
printf '%s\n' 'mfa_changed=false'
printf '%s\n' 'external_submission_changed=false'
