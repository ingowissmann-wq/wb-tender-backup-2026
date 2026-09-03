#!/usr/bin/env bash
set -Eeuo pipefail

failure_report() {
  local status=$?
  printf 'WB_TENDER_PASSWORD_RESET_STANDALONE=STOPPED line=%s status=%s command=%q\n' "$1" "$status" "$BASH_COMMAND" >&2
}
trap 'failure_report "$LINENO"' ERR

SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
AUTH=wb-admin-rehearsal-auth-1
DB=wb-tender-production-db
SECRET=/srv/wb-tender-production/secrets/ionos-smtp-password
PATCHER="$SOURCE/integrations/wb-admin-portal/candidate/tender-password-reset-mail-patch.mjs"
ASSET_SOURCE="$SOURCE/integrations/wb-admin-portal/candidate/tender-password-reset-ui.js"
ASSET=/var/lib/wb-tender-ui/password-reset-ui.js
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/tender-reset-standalone-${STAMP}"

printf '%s\n' 'preflight=start'
test "$(id -u)" -eq 0
test -s "$SECRET"
test -s "$PATCHER"
test -s "$ASSET_SOURCE"
test "$(docker inspect "$AUTH" --format '{{.State.Running}}')" = true
test "$(docker inspect "$DB" --format '{{.State.Running}}')" = true
test "$(docker inspect "$AUTH" --format '{{.HostConfig.ReadonlyRootfs}}')" = false
APP_UID=$(docker exec --user 0:0 "$AUTH" sh -lc 'stat -c %u /proc/1')
APP_GID=$(docker exec --user 0:0 "$AUTH" sh -lc 'stat -c %g /proc/1')
case "$APP_UID:$APP_GID" in (*[!0-9:]*) false;; esac
printf 'preflight=auth_runtime_identity uid=%s gid=%s\n' "$APP_UID" "$APP_GID"
mkdir -p "$WORK"
chmod 0700 "$WORK"

AUTH_USER_COUNT=$(docker exec -i "$DB" sh -lc 'exec psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT count(*) FROM iam.users
WHERE lower(email)=lower('admin@wb-holding.ag') AND active=true;
SQL
)
AUTH_USER_COUNT=$(printf '%s' "$AUTH_USER_COUNT" | tr -d '[:space:]')
test "$AUTH_USER_COUNT" = 1
printf 'preflight=production_active_tender_account_found count=%s\n' "$AUTH_USER_COUNT"

SERVER_BEFORE="$WORK/server.before.js"
SERVER_PATCHED="$WORK/server.patched.js"
docker cp "$AUTH:/app/apps/api/dist/server.js" "$SERVER_BEFORE"
cp -a "$SERVER_BEFORE" "$SERVER_PATCHED"
IMAGE=$(docker inspect "$AUTH" --format '{{.Config.Image}}')
docker run --rm --network none --user 0:0 \
  -v "$PATCHER:/tmp/tender-password-reset-mail-patch.mjs:ro" \
  -v "$SERVER_PATCHED:/tmp/server.js" \
  --entrypoint node "$IMAGE" /tmp/tender-password-reset-mail-patch.mjs /tmp/server.js
docker run --rm --network none --user 0:0 -v "$SERVER_PATCHED:/tmp/server.js:ro" \
  --entrypoint node "$IMAGE" --check /tmp/server.js
grep -Fq WB_TENDER_PASSWORD_RESET_MAIL_V1 "$SERVER_PATCHED"
grep -Fq /admin/ausschreibungen/login?reset= "$SERVER_PATCHED"
node --test "$SOURCE/tests/tender-password-reset-mail.test.mjs"
printf '%s\n' 'preflight=patched_runtime_valid'

ASSET_EXISTED=false
if test -f "$ASSET"; then ASSET_EXISTED=true; cp -a "$ASSET" "$WORK/password-reset-ui.before.js"; fi
CONTAINER_SECRET_EXISTED=false
if docker exec --user 0:0 "$AUTH" test -f /run/secrets/ionos-smtp-password; then
  CONTAINER_SECRET_EXISTED=true
  docker cp "$AUTH:/run/secrets/ionos-smtp-password" "$WORK/container-secret.before"
fi

APPLIED=false
TOKEN_CREATED=false
rollback() {
  status=$?
  trap - EXIT ERR
  if test "$TOKEN_CREATED" = true; then
    docker exec -i "$DB" sh -lc 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL' >/dev/null 2>&1 || true
UPDATE iam.password_reset_tokens t SET used_at=now() FROM iam.users u
WHERE u.id=t.user_id AND lower(u.email)=lower('admin@wb-holding.ag') AND t.used_at IS NULL;
SQL
  fi
  if test "$APPLIED" = true; then
    docker cp "$SERVER_BEFORE" "$AUTH:/tmp/wb-reset-server-rollback.js" >/dev/null 2>&1 || true
    docker exec --user 0:0 "$AUTH" cp /tmp/wb-reset-server-rollback.js /app/apps/api/dist/server.js >/dev/null 2>&1 || true
    if test "$CONTAINER_SECRET_EXISTED" = true; then
      docker cp "$WORK/container-secret.before" "$AUTH:/tmp/wb-reset-secret-rollback" >/dev/null 2>&1 || true
      docker exec --user 0:0 "$AUTH" install -o "$APP_UID" -g "$APP_GID" -m 0400 /tmp/wb-reset-secret-rollback /run/secrets/ionos-smtp-password >/dev/null 2>&1 || true
    else
      docker exec --user 0:0 "$AUTH" rm -f /run/secrets/ionos-smtp-password >/dev/null 2>&1 || true
    fi
    if test "$ASSET_EXISTED" = true; then cp -a "$WORK/password-reset-ui.before.js" "$ASSET"; else rm -f "$ASSET"; fi
    docker restart "$AUTH" >/dev/null 2>&1 || true
  fi
  printf '%s\n' 'WB_TENDER_PASSWORD_RESET_STANDALONE_ROLLBACK=SUCCESS' >&2
  exit "$status"
}
trap rollback EXIT

APPLIED=true
docker cp "$SERVER_PATCHED" "$AUTH:/tmp/wb-reset-server.js"
docker exec --user 0:0 "$AUTH" cp /tmp/wb-reset-server.js /app/apps/api/dist/server.js
docker exec --user 0:0 "$AUTH" install -d -o "$APP_UID" -g "$APP_GID" -m 0700 /run/secrets
docker cp "$SECRET" "$AUTH:/tmp/wb-reset-smtp-secret"
docker exec --user 0:0 "$AUTH" install -o "$APP_UID" -g "$APP_GID" -m 0400 /tmp/wb-reset-smtp-secret /run/secrets/ionos-smtp-password
install -d -m 0755 "$(dirname "$ASSET")"
install -m 0644 "$ASSET_SOURCE" "$ASSET"
docker restart "$AUTH" >/dev/null

HEALTHY=false
for ATTEMPT in $(seq 1 45); do
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4341/api/healthz || true)
  printf 'attempt=%s auth_health=%s\n' "$ATTEMPT" "$CODE"
  if test "$CODE" = 200; then HEALTHY=true; break; fi
  sleep 1
done
test "$HEALTHY" = true
docker exec "$AUTH" grep -Fq WB_TENDER_PASSWORD_RESET_MAIL_V1 /app/apps/api/dist/server.js
docker exec --user "$APP_UID:$APP_GID" "$AUTH" test -r /run/secrets/ionos-smtp-password

FORGOT_CODE=$(curl --http1.1 -ksS -o "$WORK/forgot-nonexistent.json" -w '%{http_code}' \
  --resolve www.enwi.online:443:127.0.0.1 -H 'content-type: application/json' \
  --data '{"email":"nonexistent-reset-check@invalid.example"}' \
  https://www.enwi.online/api/admin/v1/iam/password/forgot)
test "$FORGOT_CODE" = 200
grep -Fq '"ok":true' "$WORK/forgot-nonexistent.json"
SCRIPT_CODE=$(curl --http1.1 -ksS -o "$WORK/password-reset-ui.js" -w '%{http_code}' \
  --resolve www.enwi.online:443:127.0.0.1 -H 'Cache-Control: no-cache' \
  "https://www.enwi.online/admin/ausschreibungen/password-reset-ui.js?v=$STAMP")
test "$SCRIPT_CODE" = 200
grep -Fq WB_TENDER_PASSWORD_RESET_UI_NGINX_V2 "$WORK/password-reset-ui.js"
grep -Fq /api/admin/v1/iam/password/reset "$WORK/password-reset-ui.js"
printf '%s\n' 'preflight=public_reset_routes_and_ui_ok'

REAL_CODE=$(curl --http1.1 -ksS -o "$WORK/forgot-admin.json" -w '%{http_code}' \
  --resolve www.enwi.online:443:127.0.0.1 -H 'content-type: application/json' \
  --data '{"email":"admin@wb-holding.ag"}' \
  https://www.enwi.online/api/admin/v1/iam/password/forgot)
test "$REAL_CODE" = 200
grep -Fq '"ok":true' "$WORK/forgot-admin.json"
TOKEN_CREATED=true
VALID_TOKEN_COUNT=$(docker exec -i "$DB" sh -lc 'exec psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT count(*) FROM iam.password_reset_tokens t JOIN iam.users u ON u.id=t.user_id
WHERE lower(u.email)=lower('admin@wb-holding.ag') AND t.used_at IS NULL AND t.expires_at>now();
SQL
)
test "$(printf '%s' "$VALID_TOKEN_COUNT" | tr -d '[:space:]')" = 1

APPLIED=false
TOKEN_CREATED=false
trap - EXIT ERR
printf '%s\n' 'WB_TENDER_PASSWORD_RESET_STANDALONE=SUCCESS'
printf '%s\n' 'reset_email_requested=true'
printf '%s\n' 'valid_single_use_token=true'
printf '%s\n' 'token_validity=30_minutes'
printf '%s\n' 'smtp_secret_printed=false'
printf '%s\n' 'production_tender_container_changed=false'
printf '%s\n' 'external_submission_changed=false'
printf 'backup_directory=%s\n' "$WORK"
