#!/usr/bin/env bash
set -Eeuo pipefail

C=wb-admin-rehearsal-auth-1
EXPECTED_IMAGE='sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86'
CFG=$(readlink -f /etc/nginx/sites-enabled/wb-tender-www.conf)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/preview-route-${STAMP}"
BACKUP="${WORK}/wb-tender-www.conf.before"
TMP=$(mktemp)
CHANGED=false

mkdir -p "$WORK"
test "$(docker inspect "$C" --format '{{.State.Running}}')" = true
test "$(docker inspect "$C" --format '{{.Image}}')" = "$EXPECTED_IMAGE"
test -f "$CFG"
cp -a "$CFG" "$BACKUP"

rollback() {
  status=$?
  trap - ERR
  rm -f "$TMP"
  if test "$CHANGED" = true; then
    cp -a "$BACKUP" "$CFG"
    nginx -t >/dev/null
    systemctl reload nginx
    printf '%s\n' 'WB_PREVIEW_ROUTE_ROLLBACK=SUCCESS' >&2
  fi
  exit "$status"
}
trap rollback ERR

if ! grep -Fqx '    location ^~ /api/preview/ {' "$CFG"; then
  test "$(grep -Fxc '    location ^~ /api/admin/ {' "$CFG")" -eq 1
  awk '
    !inserted && $0 == "    location ^~ /api/admin/ {" {
      print "    location ^~ /api/preview/ {"
      print "        proxy_pass http://127.0.0.1:4341;"
      print "        include /etc/nginx/proxy_params;"
      print "        proxy_http_version 1.1;"
      print "        proxy_read_timeout 30s;"
      print "    }"
      print ""
      inserted=1
    }
    { print }
    END { if (!inserted) exit 42 }
  ' "$CFG" >"$TMP"
  cat "$TMP" >"$CFG"
  CHANGED=true
fi

test "$(grep -Fxc '    location ^~ /api/preview/ {' "$CFG")" -eq 1
nginx -t
systemctl reload nginx

CODE=
for ATTEMPT in $(seq 1 15); do
  CODE=$(curl --http1.1 -ksS -o "$WORK/no-token.json" -w '%{http_code}' \
    --resolve www.enwi.online:443:127.0.0.1 \
    'https://www.enwi.online/api/preview/v1/resolve' || true)
  if test "$CODE" != 404 && test "$CODE" != 000; then break; fi
  sleep 1
done
case "$CODE" in
  400|401) ;;
  *) printf 'preview_route_status=%s\n' "$CODE" >&2; exit 43 ;;
esac

CHANGED=false
trap - ERR
rm -f "$TMP"
printf '%s\n' 'WB_CMS_PREVIEW_ROUTE=SUCCESS'
printf 'status_without_token=%s\n' "$CODE"
printf 'backup=%s\n' "$BACKUP"
printf '%s\n' 'database_changed=false'
printf '%s\n' 'mfa_changed=false'
printf '%s\n' 'external_submission_changed=false'
