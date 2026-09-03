#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
AUTH=wb-admin-rehearsal-auth-1
DB=wb-tender-production-db
SECRET=/srv/wb-tender-production/secrets/ionos-smtp-password
ASSET_SOURCE="$SOURCE/integrations/wb-admin-portal/candidate/tender-password-reset-ui.js"
ASSET=/var/lib/wb-tender-ui/password-reset-ui.js
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/tender-reset-mail-release-${STAMP}"
BASE_TAG="wb-admin:tender-reset-base-${STAMP}"
NEW_IMAGE="wb-admin:tender-reset-mail-${STAMP}"
ROLLBACK_IMAGE="wb-admin:tender-reset-before-${STAMP}"

test "$(id -u)" -eq 0
test -s "$SECRET"
test -s "$ASSET_SOURCE"
test "$(docker inspect "$AUTH" --format '{{.State.Running}}')" = true
test "$(docker inspect "$DB" --format '{{.State.Running}}')" = true
mkdir -p "$WORK"
chmod 0700 "$WORK"
docker inspect "$AUTH" >"$WORK/auth-container.before.json"

CURRENT_IMAGE_ID=$(docker inspect "$AUTH" --format '{{.Image}}')
CURRENT_IMAGE_NAME=$(docker inspect "$AUTH" --format '{{.Config.Image}}')
test -n "$CURRENT_IMAGE_ID"
docker image inspect "$CURRENT_IMAGE_ID" >/dev/null
docker tag "$CURRENT_IMAGE_ID" "$BASE_TAG"
docker tag "$CURRENT_IMAGE_ID" "$ROLLBACK_IMAGE"

PROJECT=$(docker inspect "$AUTH" --format '{{index .Config.Labels "com.docker.compose.project"}}')
SERVICE=$(docker inspect "$AUTH" --format '{{index .Config.Labels "com.docker.compose.service"}}')
WORKING_DIR=$(docker inspect "$AUTH" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')
CONFIG_FILES=$(docker inspect "$AUTH" --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}')
test -n "$PROJECT"
test -n "$SERVICE"
test -d "$WORKING_DIR"
test -n "$CONFIG_FILES"

COMPOSE_ARGS=(-p "$PROJECT")
IFS=',' read -r -a CONFIG_PATHS <<<"$CONFIG_FILES"
for CONFIG_PATH in "${CONFIG_PATHS[@]}"; do
  if [[ "$CONFIG_PATH" != /* ]]; then CONFIG_PATH="$WORKING_DIR/$CONFIG_PATH"; fi
  test -f "$CONFIG_PATH"
  COMPOSE_ARGS+=(-f "$CONFIG_PATH")
done

DB_FACT=$(docker exec -i "$AUTH" node --input-type=module - <<'NODE'
import { pool } from "/app/apps/api/dist/db.js";
const result = await pool.query("SELECT coalesce(inet_server_addr()::text,''),current_database(),count(*)::int FROM iam.users WHERE lower(email)=lower('admin@wb-holding.ag') AND active=true GROUP BY inet_server_addr(),current_database()");
if (result.rows.length !== 1) process.exit(72);
console.log(`WBDB|${result.rows[0].coalesce}|${result.rows[0].current_database}|${result.rows[0].count}`);
await pool.end();
NODE
)
DB_FACT=$(printf '%s\n' "$DB_FACT" | awk -F'|' '$1=="WBDB" {print; exit}')
IFS='|' read -r DB_MARKER AUTH_DB_IP AUTH_DB_NAME AUTH_USER_COUNT <<<"$DB_FACT"
test "$DB_MARKER" = WBDB
test "$AUTH_USER_COUNT" = 1
test -n "$AUTH_DB_IP"
PRODUCTION_DB_NAME=$(docker inspect "$DB" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_DB=//p' | head -n1)
test -n "$PRODUCTION_DB_NAME"
test "$AUTH_DB_NAME" = "$PRODUCTION_DB_NAME"
docker inspect "$DB" --format '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' | grep -Fxq "$AUTH_DB_IP"
printf '%s\n' 'preflight=auth_service_uses_production_database'
printf '%s\n' 'preflight=active_tender_account_found'

node --test "$SOURCE/tests/tender-password-reset-mail.test.mjs"
docker build --pull=false --build-arg "BASE_IMAGE=$BASE_TAG" \
  --file "$SOURCE/deployment/Dockerfile.tender-password-reset-mail" \
  --tag "$NEW_IMAGE" "$SOURCE"
docker run --rm --network none --entrypoint sh "$NEW_IMAGE" -c \
  'grep -Fq WB_TENDER_PASSWORD_RESET_MAIL_V1 /app/apps/api/dist/server.js && grep -Fq SMTP_PASSWORD_FILE /app/apps/api/dist/server.js && grep -Fq "/admin/ausschreibungen/login?reset=" /app/apps/api/dist/server.js'

cat >"$WORK/compose-new.yml" <<YAML
services:
  ${SERVICE}:
    image: ${NEW_IMAGE}
    user: "0:0"
    environment:
      SMTP_HOST: smtp.ionos.de
      SMTP_PORT: "465"
      SMTP_SECURE: "true"
      SMTP_USER: admin@wb-holding.ag
      SMTP_PASSWORD_FILE: /run/secrets/ionos-smtp-password
      SYSTEM_MAIL_FROM: admin@wb-holding.ag
      PUBLIC_ORIGIN: https://www.enwi.online
    volumes:
      - type: bind
        source: ${SECRET}
        target: /run/secrets/ionos-smtp-password
        read_only: true
YAML
cat >"$WORK/compose-rollback.yml" <<YAML
services:
  ${SERVICE}:
    image: ${ROLLBACK_IMAGE}
YAML
docker compose "${COMPOSE_ARGS[@]}" -f "$WORK/compose-new.yml" config >/dev/null
docker compose "${COMPOSE_ARGS[@]}" -f "$WORK/compose-rollback.yml" config >/dev/null

ASSET_EXISTED=false
if test -f "$ASSET"; then
  ASSET_EXISTED=true
  cp -a "$ASSET" "$WORK/password-reset-ui.before.js"
fi

SWAPPED=false
ASSET_CHANGED=false
TOKEN_CREATED=false
rollback() {
  status=$?
  trap - EXIT
  if test "$TOKEN_CREATED" = true; then
    docker exec -i "$DB" sh -lc 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL' >/dev/null 2>&1 || true
UPDATE iam.password_reset_tokens t SET used_at=now()
FROM iam.users u WHERE u.id=t.user_id AND lower(u.email)=lower('admin@wb-holding.ag') AND t.used_at IS NULL;
SQL
  fi
  if test "$ASSET_CHANGED" = true; then
    if test "$ASSET_EXISTED" = true; then cp -a "$WORK/password-reset-ui.before.js" "$ASSET"; else rm -f "$ASSET"; fi
  fi
  if test "$SWAPPED" = true; then
    docker compose "${COMPOSE_ARGS[@]}" -f "$WORK/compose-rollback.yml" up -d --no-deps --force-recreate "$SERVICE" >/dev/null 2>&1 || true
  fi
  printf '%s\n' 'WB_TENDER_PASSWORD_RESET_MAIL_ROLLBACK=SUCCESS' >&2
  exit "$status"
}
trap rollback EXIT

SWAPPED=true
docker compose "${COMPOSE_ARGS[@]}" -f "$WORK/compose-new.yml" up -d --no-deps --force-recreate "$SERVICE"

HEALTHY=false
for ATTEMPT in $(seq 1 45); do
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4341/api/healthz || true)
  printf 'attempt=%s auth_health=%s\n' "$ATTEMPT" "$CODE"
  if test "$CODE" = 200; then HEALTHY=true; break; fi
  sleep 1
done
test "$HEALTHY" = true
test "$(docker inspect "$AUTH" --format '{{.Image}}')" = "$(docker image inspect "$NEW_IMAGE" --format '{{.Id}}')"
docker exec "$AUTH" sh -c 'test -s /run/secrets/ionos-smtp-password && grep -Fq WB_TENDER_PASSWORD_RESET_MAIL_V1 /app/apps/api/dist/server.js'
docker exec "$AUTH" sh -c "awk '/^Uid:/{exit (\$2==0)}' /proc/1/status"
printf '%s\n' 'preflight=runtime_dropped_root_privileges'

install -d -m 0755 "$(dirname "$ASSET")"
ASSET_CHANGED=true
install -m 0644 "$ASSET_SOURCE" "$ASSET"
node --check "$ASSET"

FORGOT_CODE=$(curl --http1.1 -ksS -o "$WORK/forgot-nonexistent.json" -w '%{http_code}' \
  --resolve www.enwi.online:443:127.0.0.1 -H 'content-type: application/json' \
  --data '{"email":"nonexistent-reset-release-check@invalid.example"}' \
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

SWAPPED=false
ASSET_CHANGED=false
TOKEN_CREATED=false
trap - EXIT
docker inspect "$AUTH" >"$WORK/auth-container.after.json"
printf '%s\n' 'WB_TENDER_PASSWORD_RESET_MAIL=SUCCESS'
printf '%s\n' 'reset_email_requested=true'
printf '%s\n' 'valid_single_use_token=true'
printf '%s\n' 'token_validity=30_minutes'
printf '%s\n' 'smtp_secret_printed=false'
printf '%s\n' 'production_tender_container_changed=false'
printf '%s\n' 'external_submission_changed=false'
printf 'previous_auth_image=%s\n' "$CURRENT_IMAGE_NAME"
printf 'rollback_image=%s\n' "$ROLLBACK_IMAGE"
printf 'audit_directory=%s\n' "$WORK"
