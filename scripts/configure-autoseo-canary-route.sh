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

test "$(docker inspect "$C" --format '{{.State.Running}}')" = true
test -f "$CFG"
mkdir -p "$WORK"
cp -a "$CFG" "$BACKUP"

MEDIA_ID=$(docker exec -e NODE_NO_WARNINGS=1 "$C" node --input-type=module <<'NODE'
import { DatabaseSync } from "node:sqlite";
const db=new DatabaseSync("/data/career.db",{readOnly:true});
const rows=db.prepare("SELECT payload FROM content_items WHERE collection IN ('jobangebote','teammembers') ORDER BY updated_at DESC").all();
db.close();
for(const row of rows){
  const data=JSON.parse(row.payload);
  const id=data.imageId||data.cardImageId||data.detailImageId;
  if(id){process.stdout.write(id);process.exit(0);}
}
process.exit(2);
NODE
)
test -n "$MEDIA_ID"
test "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:4341/cms-media/${MEDIA_ID}")" = 200
printf '%s\n' 'preflight=canary_media_ok'

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

ADD_MEDIA=false
ADD_AUTOSEO=false
grep -Fqx '    location ^~ /cms-media/ {' "$CFG" || ADD_MEDIA=true
grep -Fqx '    location = /api/integrations/autoseo/webhook {' "$CFG" || ADD_AUTOSEO=true

if test "$ADD_MEDIA" = true || test "$ADD_AUTOSEO" = true; then
  test "$(grep -Fxc '    location ^~ /api/admin/ {' "$CFG")" -eq 1
  awk -v add_media="$ADD_MEDIA" -v add_autoseo="$ADD_AUTOSEO" '
    !inserted && $0 == "    location ^~ /api/admin/ {" {
      if (add_media == "true") {
        print "    location ^~ /cms-media/ {"
        print "        proxy_pass http://127.0.0.1:4341;"
        print "        include /etc/nginx/proxy_params;"
        print "        proxy_http_version 1.1;"
        print "        proxy_read_timeout 60s;"
        print "    }"
        print ""
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
fi

test "$(grep -Fxc '    location ^~ /cms-media/ {' "$CFG")" -eq 1
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
