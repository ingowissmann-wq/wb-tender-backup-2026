#!/usr/bin/env bash
set -Eeuo pipefail

C=wb-admin-rehearsal-auth-1
CFG=$(readlink -f /etc/nginx/sites-enabled/wb-tender-www.conf)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/autoseo-route-${STAMP}"
BACKUP="$WORK/wb-tender-www.conf.before"
TMP=$(mktemp)

test "$(docker inspect "$C" --format '{{.State.Running}}')" = true
test -f "$CFG"
mkdir -p "$WORK"
cp -a "$CFG" "$BACKUP"

ROLLBACK=true
rollback() {
  STATUS=$?
  rm -f "$TMP"
  if test "$ROLLBACK" = true; then
    cp -a "$BACKUP" "$CFG"
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx
      printf '%s\n' 'WB_AUTOSEO_ROUTE_ROLLBACK=SUCCESS'
    fi
  fi
  exit "$STATUS"
}
trap rollback EXIT

if ! grep -Fqx '    location ^~ /cms-media/ {' "$CFG"; then
  test "$(grep -Fxc '    location ^~ /api/admin/ {' "$CFG")" -eq 1
  awk '
    !inserted && $0 == "    location ^~ /api/admin/ {" {
      print "    location ^~ /cms-media/ {"
      print "        proxy_pass http://127.0.0.1:4341;"
      print "        include /etc/nginx/proxy_params;"
      print "        proxy_http_version 1.1;"
      print "        proxy_read_timeout 60s;"
      print "    }"
      print ""
      inserted=1
    }
    { print }
    END { if (!inserted) exit 42 }
  ' "$CFG" > "$TMP"
  cat "$TMP" > "$CFG"
fi

if ! grep -Fqx '    location = /api/integrations/autoseo/webhook {' "$CFG"; then
  test "$(grep -Fxc '    location ^~ /api/admin/ {' "$CFG")" -eq 1
  awk '
    !inserted && $0 == "    location ^~ /api/admin/ {" {
      print "    location = /api/integrations/autoseo/webhook {"
      print "        proxy_pass http://127.0.0.1:4341;"
      print "        include /etc/nginx/proxy_params;"
      print "        proxy_http_version 1.1;"
      print "        proxy_read_timeout 60s;"
      print "    }"
      print ""
      inserted=1
    }
    { print }
    END { if (!inserted) exit 42 }
  ' "$CFG" > "$TMP"
  cat "$TMP" > "$CFG"
fi

test "$(grep -Fxc '    location = /api/integrations/autoseo/webhook {' "$CFG")" -eq 1
test "$(grep -Fxc '    location ^~ /cms-media/ {' "$CFG")" -eq 1
nginx -t
systemctl reload nginx

MEDIA_ID=$(docker exec "$C" node --input-type=module <<'NODE'
import fs from "node:fs";
import pg from "pg";
const entry=fs.readFileSync("/proc/1/environ").toString("utf8").split("\0").find(value=>value.startsWith("DATABASE_URL="));
if(!entry) process.exit(2);
const pool=new pg.Pool({connectionString:entry.slice("DATABASE_URL=".length),max:1});
const result=await pool.query("SELECT id FROM files.objects WHERE protection_class='public' AND deleted_at IS NULL AND missing_binary=false ORDER BY created_at DESC LIMIT 1");
await pool.end();
if(!result.rows[0]?.id) process.exit(3);
process.stdout.write(result.rows[0].id);
NODE
)
MEDIA_HEADERS=$(curl -ksS -D - -o /dev/null "https://www.enwi.online/cms-media/${MEDIA_ID}")
printf '%s\n' "$MEDIA_HEADERS" | grep -Eq '^HTTP/[^ ]+ 200'
printf '%s\n' "$MEDIA_HEADERS" | grep -Eiq '^content-type: image/'
printf '%s\n' '{"cmsMedia":"ok"}'

TEST_RESULT=$(docker exec "$C" node --input-type=module <<'NODE'
import fs from "node:fs/promises";
import crypto from "node:crypto";
const secretPath=process.env.AUTOSEO_SECRET_FILE || "/run/secrets/autoseo_webhook";
const {token}=JSON.parse(await fs.readFile(secretPath,"utf8"));
if(typeof token!=="string" || token.length<32) throw new Error("autoseo_secret_invalid");
const body=JSON.stringify({event:"test"});
const signature=crypto.createHmac("sha256",token).update(body).digest("hex");
const response=await fetch("https://www.enwi.online/api/integrations/autoseo/webhook",{
  method:"POST",headers:{"content-type":"application/json","authorization":`Bearer ${token}`,
  "x-autoseo-signature":`sha256=${signature}`,"x-autoseo-delivery":`canary-test-${Date.now()}`,
  "x-autoseo-event":"test"},body,signal:AbortSignal.timeout(15000)});
const text=await response.text();
if(response.status!==200) throw new Error(`autoseo_public_test_${response.status}:${text.slice(0,200)}`);
const parsed=JSON.parse(text);
if(parsed.status!=="ok") throw new Error("autoseo_test_response_invalid");
process.stdout.write(JSON.stringify({status:response.status,result:parsed.status,url:parsed.url}));
NODE
)
printf '%s\n' "$TEST_RESULT"

ROLLBACK=false
trap - EXIT
rm -f "$TMP"
printf '%s\n' 'WB_AUTOSEO_CANARY_ROUTE=SUCCESS'
printf '%s\n' 'webhook=https://www.enwi.online/api/integrations/autoseo/webhook'
printf '%s\n' 'cms_media_route=https://www.enwi.online/cms-media/'
printf 'backup=%s\n' "$BACKUP"
printf '%s\n' 'article_sent=false' 'production_database_changed=false' 'external_submission_changed=false'
