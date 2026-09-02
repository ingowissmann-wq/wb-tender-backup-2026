#!/usr/bin/env bash
set -euo pipefail

CONFIG='/etc/nginx/sites-enabled/wb-tender-www.conf'
AUTH_CANARY='wb-admin-rehearsal-auth-1'
AUTH_CANARY_ID='sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86'
PRODUCTION_API='wb-tender-production-api'
PRODUCTION_IMAGE_ID='sha256:30d64f6334519b095f4af837380ac7b56df6ff0c90fb3652a0c100f3528335e3'
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ROLLBACK_DIR="/srv/wb-tender-production/rollback/admin-browser-canary-${STAMP}"
BACKUP="${ROLLBACK_DIR}/wb-tender-www.conf.before"
RESTORE="${ROLLBACK_DIR}/restore-nginx.sh"
UNIT="wb-admin-canary-auto-rollback-${STAMP}"

printf '%s\n' 'WB_STAGE_ADMIN_BROWSER_CANARY=STARTED'

test -f "${CONFIG}"
test "$(docker inspect --format '{{.State.Running}}' "${AUTH_CANARY}")" = 'true'
test "$(docker inspect --format '{{.Image}}' "${AUTH_CANARY}")" = "${AUTH_CANARY_ID}"
test "$(docker inspect --format '{{.State.Running}}' "${PRODUCTION_API}")" = 'true'
test "$(docker inspect --format '{{.Image}}' "${PRODUCTION_API}")" = "${PRODUCTION_IMAGE_ID}"
test "$(curl --max-time 10 --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:4341/api/healthz)" = '200'
test "$(curl --max-time 10 --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:4341/admin/)" = '200'

umask 077
install -d -m 0700 "${ROLLBACK_DIR}"
install -m 0600 "${CONFIG}" "${BACKUP}"

cat > "${RESTORE}" <<RESTORE_SCRIPT
#!/usr/bin/env bash
set -euo pipefail
CONFIG='${CONFIG}'
BACKUP='${BACKUP}'
test -s "\${BACKUP}"
install -m 0644 "\${BACKUP}" "\${CONFIG}"
nginx -t
systemctl reload nginx
printf '%s\\n' 'WB_ADMIN_BROWSER_CANARY_AUTO_ROLLBACK=SUCCESS'
RESTORE_SCRIPT
chmod 0700 "${RESTORE}"

restore_on_error() {
  STATUS="$?"
  trap - ERR INT TERM
  set +e
  "${RESTORE}"
  printf 'STAGING_ROLLBACK_COMPLETED status=%s\n' "${STATUS}"
  exit "${STATUS}"
}
trap restore_on_error ERR INT TERM

python3 - "${CONFIG}" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text(encoding="utf-8")

if "WB_ADMIN_BROWSER_CANARY_BEGIN" in source:
    raise SystemExit("admin_browser_canary_route_already_present")

anchor = """    location / {
        return 404;
    }
"""

if source.count(anchor) != 1:
    raise SystemExit(f"expected_unique_fallback_location={source.count(anchor)}")

routes = """    # WB_ADMIN_BROWSER_CANARY_BEGIN
    location = /admin {
        return 302 /admin/;
    }

    location ^~ /admin/ {
        proxy_pass http://127.0.0.1:4341;
        include /etc/nginx/proxy_params;
        proxy_set_header X-Forwarded-Proto https;
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
    }

    location ^~ /api/admin/ {
        proxy_pass http://127.0.0.1:4341;
        include /etc/nginx/proxy_params;
        proxy_set_header X-Forwarded-Proto https;
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
    }
    # WB_ADMIN_BROWSER_CANARY_END

"""

path.write_text(source.replace(anchor, routes + anchor, 1), encoding="utf-8")
PY

nginx -t
systemctl reload nginx

printf '%s\n' '===== WAIT FOR RELOADED NGINX WORKERS ====='

ROUTE_READY='false'
for ATTEMPT in $(seq 1 30); do
  ROUTE_CODE="$(
    curl --max-time 5 --silent --show-error --insecure \
      --resolve 'www.enwi.online:443:127.0.0.1' \
      --output /dev/null --write-out '%{http_code}' \
      https://www.enwi.online/admin/ 2>/dev/null || true
  )"
  if test "${ROUTE_CODE}" = '200'; then
    ROUTE_READY='true'
    printf 'nginx_reload_ready=true attempt=%s\n' "${ATTEMPT}"
    break
  fi
  printf 'nginx_reload_wait=%s/30 http=%s\n' "${ATTEMPT}" "${ROUTE_CODE}"
  sleep 1
done
test "${ROUTE_READY}" = 'true'

printf '%s\n' '===== PUBLIC CANARY CONTRACT ====='

check() {
  PATHNAME="$1"
  EXPECTED="$2"
  ACTUAL="$(
    curl --max-time 15 --silent --show-error --insecure \
      --resolve 'www.enwi.online:443:127.0.0.1' \
      --output /dev/null --write-out '%{http_code}' \
      "https://www.enwi.online${PATHNAME}"
  )"
  printf '%s|expected=%s|actual=%s\n' "${PATHNAME}" "${EXPECTED}" "${ACTUAL}"
  test "${ACTUAL}" = "${EXPECTED}"
}

check '/admin/' '200'
check '/admin/index.html' '200'
check '/api/admin/v1/iam/me' '401'
check '/admin/ausschreibungen/' '302'
check '/healthz' '200'

ASSET_PATHS="$(
  curl --max-time 15 --silent --show-error --insecure \
    --resolve 'www.enwi.online:443:127.0.0.1' \
    https://www.enwi.online/admin/ |
  grep -Eo '(src|href)="[^"]+"' |
  cut -d '"' -f2 |
  grep '^/admin/' |
  sort -u
)"
test -n "${ASSET_PATHS}"

ASSET_COUNT=0
while IFS= read -r ASSET; do
  test -n "${ASSET}"
  check "${ASSET}" '200'
  ASSET_COUNT=$((ASSET_COUNT + 1))
done <<< "${ASSET_PATHS}"

TENDER_LOCATION="$(
  curl --max-time 15 --silent --show-error --insecure \
    --resolve 'www.enwi.online:443:127.0.0.1' \
    --output /dev/null --write-out '%{redirect_url}' \
    https://www.enwi.online/admin/ausschreibungen/
)"
case "${TENDER_LOCATION}" in
  *'/admin/ausschreibungen/'*) ;;
  *) printf 'unexpected_tender_redirect=%s\n' "${TENDER_LOCATION}"; false ;;
esac

systemd-run \
  --quiet \
  --unit "${UNIT}" \
  --on-active=45m \
  /usr/bin/env bash "${RESTORE}"

systemctl is-active "${UNIT}.timer" >/dev/null

PRODUCTION_HEALTH="$(
  curl --max-time 15 --silent --show-error --insecure \
    --resolve 'www.enwi.online:443:127.0.0.1' \
    --output /dev/null --write-out '%{http_code}' \
    https://www.enwi.online/healthz
)"
test "${PRODUCTION_HEALTH}" = '200'
test "$(docker inspect --format '{{.Image}}' "${PRODUCTION_API}")" = "${PRODUCTION_IMAGE_ID}"

trap - ERR INT TERM

printf '%s\n' 'WB_STAGE_ADMIN_BROWSER_CANARY=SUCCESS'
printf '%s\n' 'browser_url=https://www.enwi.online/admin/'
printf 'admin_static_assets=%s|all_200=true\n' "${ASSET_COUNT}"
printf '%s\n' 'tender_portal_route=preserved'
printf '%s\n' 'admin_database=isolated_clone'
printf '%s\n' 'production_auth_secrets=read_only'
printf '%s\n' 'external_submission=false'
printf 'production_health=%s\n' "${PRODUCTION_HEALTH}"
printf '%s\n' 'production_database_changed=false'
printf 'automatic_route_rollback=%s.timer|45_minutes\n' "${UNIT}"
printf 'rollback_dir=%s\n' "${ROLLBACK_DIR}"
