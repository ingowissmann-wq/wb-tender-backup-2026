#!/usr/bin/env bash
set -Eeuo pipefail

C=wb-admin-rehearsal-auth-1
CFG=$(readlink -f /etc/nginx/sites-enabled/wb-tender-www.conf)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/final-routing-${STAMP}"
BACKUP="$WORK/wb-tender-www.conf.before"
INDEX=/app/apps/admin/dist/index.html
TMP=$(mktemp)
NEW_ASSET=
MEDIA_ROOT=/var/lib/wb-admin-canary-media
MEDIA_DIR="$MEDIA_ROOT/$STAMP"
MEDIA_INCLUDE="/etc/nginx/snippets/wb-admin-canary-media-${STAMP}.conf"

test "$(docker inspect "$C" --format '{{.State.Running}}')" = true
test -f "$CFG"
mkdir -p "$WORK"
cp -a "$CFG" "$BACKUP"

CANARY_DATABASE_URL=$(docker exec "$C" node --input-type=module -e '
  import fs from "node:fs";
  const entry=fs.readFileSync("/proc/1/environ").toString("utf8").split("\0").find(value=>value.startsWith("DATABASE_URL="));
  if(!entry) process.exit(2);
  process.stdout.write(entry.slice("DATABASE_URL=".length));')
test -n "$CANARY_DATABASE_URL"
docker exec -e DATABASE_URL="$CANARY_DATABASE_URL" "$C" node --input-type=module <<'NODE'
import fs from "node:fs"; import pg from "pg";
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
const result=await pool.query(`SELECT id::text,storage_name,mime_type FROM files.objects
  WHERE protection_class='public' AND verified=true AND deleted_at IS NULL ORDER BY id`);
await pool.end();
const allowed=new Set(["image/jpeg","image/png","image/webp"]);
const rows=result.rows.filter(row=>allowed.has(row.mime_type)&&fs.existsSync(`/data/private/${row.storage_name}`));
if(!rows.length) process.exit(3);
fs.writeFileSync("/tmp/wb-public-media.tsv",rows.map(row=>`${row.id}\t${row.storage_name}\t${row.mime_type}`).join("\n")+"\n",{mode:0o600});
NODE
docker cp "$C:/tmp/wb-public-media.tsv" "$WORK/public-media.tsv"
docker exec "$C" rm -f /tmp/wb-public-media.tsv

install -d -m 0755 "$MEDIA_ROOT" "$MEDIA_DIR"
: > "$MEDIA_INCLUDE"
chmod 0644 "$MEDIA_INCLUDE"
MEDIA_COUNT=0
MEDIA_ID=
while IFS=$'\t' read -r ID STORAGE MIME; do
  [[ "$ID" =~ ^[0-9a-fA-F-]{36}$ ]]
  test "$STORAGE" = "$(basename -- "$STORAGE")"
  case "$MIME" in
    image/jpeg) EXT=jpg ;;
    image/png) EXT=png ;;
    image/webp) EXT=webp ;;
    *) exit 44 ;;
  esac
  docker cp "$C:/data/private/$STORAGE" "$MEDIA_DIR/$ID.$EXT" >/dev/null
  chmod 0644 "$MEDIA_DIR/$ID.$EXT"
  printf '    location = /cms-media/%s { alias %s/%s.%s; default_type %s; add_header Cache-Control "public, max-age=3600"; }\n' \
    "$ID" "$MEDIA_DIR" "$ID" "$EXT" "$MIME" >> "$MEDIA_INCLUDE"
  MEDIA_COUNT=$((MEDIA_COUNT+1))
  if test -z "$MEDIA_ID"; then MEDIA_ID=$ID; fi
done < "$WORK/public-media.tsv"
test "$MEDIA_COUNT" -gt 0
printf '%s\n' '    location ^~ /cms-media/ { return 404; }' >> "$MEDIA_INCLUDE"
printf 'preflight=public_media_copy_ok files=%s\n' "$MEDIA_COUNT"

ASSET=$(docker exec "$C" node --input-type=module -e '
  import fs from "node:fs"; import path from "node:path";
  const html=fs.readFileSync("/app/apps/admin/dist/index.html","utf8");
  const match=html.match(/(?:src|href)="(?:\/admin\/)?(assets\/index-[^"]+[.]js)"/);
  if(!match) process.exit(2);
  const file=path.join("/app/apps/admin/dist",match[1]);
  if(!fs.existsSync(file)) process.exit(3);
  process.stdout.write(file);')
docker cp "$C:$INDEX" "$WORK/index.before.html"
docker cp "$C:$ASSET" "$WORK/admin-asset.before.js"

ROLLBACK=true
rollback() {
  STATUS=$?
  rm -f "$TMP"
  if test "$ROLLBACK" = true; then
    cp -a "$BACKUP" "$CFG"
    docker cp "$WORK/index.before.html" "$C:$INDEX" >/dev/null 2>&1 || true
    if test -n "$NEW_ASSET"; then docker exec "$C" rm -f "$NEW_ASSET" >/dev/null 2>&1 || true; fi
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx
      printf '%s\n' 'WB_FINAL_ROUTING_ROLLBACK=SUCCESS'
    fi
  fi
  exit "$STATUS"
}
trap rollback EXIT

NEW_ASSET="${ASSET%.js}-wbfix-${STAMP}.js"
docker exec "$C" node --input-type=module - "$ASSET" "$NEW_ASSET" "$INDEX" <<'NODE'
import fs from "node:fs"; import path from "node:path";
const [, , sourcePath, targetPath, indexPath]=process.argv;
const wrong="/api/admin/v1/resources/responsibilities";
const right="/api/admin/v1/recruiting/responsibilities";
const source=fs.readFileSync(sourcePath,"utf8").split(wrong).join(right);
if(source.includes(wrong)||!source.includes(right)) throw new Error("responsibilities_endpoint_verification_failed");
fs.writeFileSync(targetPath,source);
let html=fs.readFileSync(indexPath,"utf8");
const oldName=path.basename(sourcePath), newName=path.basename(targetPath);
const count=html.split(oldName).length-1;
if(count!==1) throw new Error(`admin_asset_reference_count:${count}`);
fs.writeFileSync(indexPath,html.replace(oldName,newName));
console.log(JSON.stringify({responsibilitiesEndpoint:"ok",cacheBustedAsset:newName}));
NODE

ADD_AUTOSEO=false
grep -Fqx '    location = /api/integrations/autoseo/webhook {' "$CFG" || ADD_AUTOSEO=true
test "$(grep -Fxc '    location ^~ /api/admin/ {' "$CFG")" -eq 1
awk -v media_include="    include ${MEDIA_INCLUDE};" -v add_autoseo="$ADD_AUTOSEO" '
    /^[[:space:]]*include \/etc\/nginx\/snippets\/wb-admin-canary-media-.*[.]conf;[[:space:]]*$/ {
      if (!media_inserted) print media_include
      media_inserted=1
      next
    }
    !inserted && $0 == "    location ^~ /api/admin/ {" {
      if (!media_inserted) {
        print media_include
        print ""
        media_inserted=1
      }
      if (add_autoseo == "true") {
        print "    location = /api/integrations/autoseo/webhook {"
        print "        proxy_pass http://127.0.0.1:4341;"
        print "        include /etc/nginx/proxy_params;"
        print "        proxy_http_version 1.1;"
        print "        proxy_read_timeout 60s;"
        print "    }"
        print ""
      }
      inserted=1
    }
    { print }
    END { if (!inserted) exit 42 }
  ' "$CFG" > "$TMP"
cat "$TMP" > "$CFG"

test "$(grep -Fxc "    include ${MEDIA_INCLUDE};" "$CFG")" -eq 1
test "$(grep -Fxc '    location = /api/integrations/autoseo/webhook {' "$CFG")" -eq 1
nginx -t
systemctl reload nginx

MEDIA_OK=false
for ATTEMPT in $(seq 1 15); do
  CODE=$(curl -ksS -o /dev/null -w '%{http_code}' "https://www.enwi.online/cms-media/${MEDIA_ID}" || true)
  if test "$CODE" = 200; then MEDIA_OK=true; break; fi
  sleep 1
done
test "$MEDIA_OK" = true
printf '%s\n' 'public_media=200'

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
printf '%s\n' 'WB_FINAL_CANARY_ROUTING=SUCCESS'
printf '%s\n' 'WB_CMS_MEDIA_CANARY_ROUTE=SUCCESS'
printf '%s\n' 'WB_AUTOSEO_CANARY_ROUTE=SUCCESS'
printf '%s\n' 'webhook=https://www.enwi.online/api/integrations/autoseo/webhook'
printf 'backup=%s\n' "$BACKUP"
printf '%s\n' 'article_sent=false' 'production_database_changed=false' 'external_submission_changed=false'
