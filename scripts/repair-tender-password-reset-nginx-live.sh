#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ASSET_SOURCE="$SOURCE/integrations/wb-admin-portal/candidate/tender-password-reset-ui.js"
CFG=$(readlink -f /etc/nginx/sites-enabled/wb-tender-www.conf)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/tender-password-reset-nginx-${STAMP}"
ASSET_DIR=/var/lib/wb-tender-ui
ASSET="$ASSET_DIR/password-reset-ui.js"
SNIPPET=/etc/nginx/snippets/wb-tender-password-reset-ui.conf
INCLUDE='    include /etc/nginx/snippets/wb-tender-password-reset-ui.conf;'
CFG_BACKUP="$WORK/wb-tender-www.conf.before"
ASSET_BACKUP="$WORK/password-reset-ui.js.before"
SNIPPET_BACKUP="$WORK/wb-tender-password-reset-ui.conf.before"
TMP="$WORK/wb-tender-www.conf.candidate"

test -f "$ASSET_SOURCE"
test -f "$CFG"
command -v nginx >/dev/null
command -v python3 >/dev/null
nginx -V 2>&1 | grep -Fq -- '--with-http_sub_module'
mkdir -p "$WORK"
cp -a "$CFG" "$CFG_BACKUP"

ASSET_EXISTED=false
SNIPPET_EXISTED=false
if test -f "$ASSET"; then
  ASSET_EXISTED=true
  cp -a "$ASSET" "$ASSET_BACKUP"
fi
if test -f "$SNIPPET"; then
  SNIPPET_EXISTED=true
  cp -a "$SNIPPET" "$SNIPPET_BACKUP"
fi

ROLLBACK=true
rollback() {
  status=$?
  trap - EXIT
  if test "$ROLLBACK" = true; then
    cp -a "$CFG_BACKUP" "$CFG" >/dev/null 2>&1 || true
    if test "$ASSET_EXISTED" = true; then
      cp -a "$ASSET_BACKUP" "$ASSET" >/dev/null 2>&1 || true
    else
      rm -f "$ASSET"
    fi
    if test "$SNIPPET_EXISTED" = true; then
      cp -a "$SNIPPET_BACKUP" "$SNIPPET" >/dev/null 2>&1 || true
    else
      rm -f "$SNIPPET"
    fi
    if nginx -t >/dev/null 2>&1; then systemctl reload nginx >/dev/null 2>&1 || true; fi
    printf '%s\n' 'WB_TENDER_PASSWORD_RESET_NGINX_ROLLBACK=SUCCESS' >&2
  fi
  exit "$status"
}
trap rollback EXIT

install -d -m 0755 "$ASSET_DIR" /etc/nginx/snippets
install -m 0644 "$ASSET_SOURCE" "$ASSET"
node --check "$ASSET" 2>/dev/null || docker run --rm --network none --user 0:0 \
  -v "$ASSET:/tmp/password-reset-ui.js:ro" \
  --entrypoint node \
  sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86 \
  --check /tmp/password-reset-ui.js

printf '%s\n' \
  'proxy_set_header Accept-Encoding "";' \
  'sub_filter_once on;' \
  "sub_filter '</body>' '<script src=\"/admin/ausschreibungen/password-reset-ui.js?v=${STAMP}\"></script></body>';" \
  'location = /admin/ausschreibungen/password-reset-ui.js {' \
  '    alias /var/lib/wb-tender-ui/password-reset-ui.js;' \
  '    default_type application/javascript;' \
  '    add_header Cache-Control "no-store";' \
  '}' >"$SNIPPET"
chmod 0644 "$SNIPPET"

python3 - "$CFG" "$TMP" "$INCLUDE" <<'PY'
import re
import sys
source, target, include = sys.argv[1:]
text = open(source, encoding="utf-8").read()
lines = text.splitlines(keepends=True)
depth = 0
start = None
blocks = []
for index, line in enumerate(lines):
    stripped = line.strip()
    before = depth
    depth += line.count("{") - line.count("}")
    if start is None and re.match(r"^server\s*\{", stripped):
        start = index
        server_depth = before
    if start is not None and depth == server_depth:
        blocks.append((start, index))
        start = None
matches = []
for begin, end in blocks:
    block = "".join(lines[begin:end + 1])
    if re.search(r"\blisten\s+[^;]*443\b", block) and re.search(r"\bserver_name\s+[^;]*\b(?:www\.)?enwi\.online\b", block):
        matches.append((begin, end))
if not matches:
    raise SystemExit("https_enwi_server_missing")
insertions = []
for begin, end in matches:
    block = "".join(lines[begin:end + 1])
    if include.strip() in block:
        continue
    insert_at = None
    for index in range(begin, end + 1):
        if re.search(r"^\\s*server_name\\s+", lines[index]):
            insert_at = index + 1
            break
    if insert_at is None:
        raise SystemExit("enwi_server_name_line_missing")
    insertions.append(insert_at)
for insert_at in sorted(insertions, reverse=True):
    lines.insert(insert_at, include + "\\n")
open(target, "w", encoding="utf-8").writelines(lines)
PY

grep -Fq "$INCLUDE" "$TMP"
cat "$TMP" >"$CFG"
nginx -t
systemctl reload nginx

LOGIN="$WORK/login.html"
SCRIPT="$WORK/password-reset-ui.js"
READY=false
for ATTEMPT in $(seq 1 20); do
  LOGIN_CODE=$(curl --http1.1 -ksS -o "$LOGIN" -w '%{http_code}' \
    --resolve www.enwi.online:443:127.0.0.1 \
    -H 'Cache-Control: no-cache' \
    "https://www.enwi.online/admin/ausschreibungen/login?wb_reset=${STAMP}" || true)
  SCRIPT_CODE=$(curl --http1.1 -ksS -o "$SCRIPT" -w '%{http_code}' \
    --resolve www.enwi.online:443:127.0.0.1 \
    "https://www.enwi.online/admin/ausschreibungen/password-reset-ui.js?v=${STAMP}" || true)
  printf 'attempt=%s login=%s script=%s\n' "$ATTEMPT" "$LOGIN_CODE" "$SCRIPT_CODE"
  if test "$LOGIN_CODE" = 200 && test "$SCRIPT_CODE" = 200; then READY=true; break; fi
  sleep 1
done
test "$READY" = true
grep -Fq '/admin/ausschreibungen/password-reset-ui.js' "$LOGIN"
grep -Fq 'WB_TENDER_PASSWORD_RESET_UI_NGINX' "$SCRIPT"
grep -Fq '/api/admin/v1/iam/password/forgot' "$SCRIPT"

RESET_CODE=$(curl --http1.1 -ksS -o "$WORK/forgot-check.json" -w '%{http_code}' \
  --resolve www.enwi.online:443:127.0.0.1 \
  -H 'content-type: application/json' \
  --data '{"email":"nonexistent-reset-nginx-check@invalid.example"}' \
  'https://www.enwi.online/api/admin/v1/iam/password/forgot')
test "$RESET_CODE" = 200
grep -Fq '"ok":true' "$WORK/forgot-check.json"

ROLLBACK=false
trap - EXIT
printf '%s\n' 'WB_TENDER_PASSWORD_RESET_LIVE=SUCCESS'
printf '%s\n' 'login_ui=200'
printf '%s\n' 'reset_request_api=200'
printf '%s\n' 'production_container_changed=false'
printf '%s\n' 'database_changed=false'
printf '%s\n' 'mfa_changed=false'
printf '%s\n' 'external_submission_changed=false'
printf 'backup_directory=%s\n' "$WORK"
