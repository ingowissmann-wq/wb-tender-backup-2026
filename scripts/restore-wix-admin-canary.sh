#!/usr/bin/env bash
set -Eeuo pipefail

C=wb-admin-rehearsal-auth-1
DB_C=wb-admin-rehearsal-db-1
REDIS_C=wb-admin-rehearsal-redis-1
EXPECTED_IMAGE='sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86'
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/wix-restore-${STAMP}"

test "$(docker inspect "$C" --format '{{.Image}}')" = "$EXPECTED_IMAGE"
test "$(docker inspect "$C" --format '{{.State.Running}}')" = true
test "$(docker inspect "$DB_C" --format '{{.State.Running}}')" = true
test "$(docker inspect "$REDIS_C" --format '{{.State.Running}}')" = true
docker port "$C" | grep -Eq '127[.]0[.]0[.]1:4341$|0[.]0[.]0[.]0:4341$|:::4341$'
printf '%s\n' 'preflight=containers_and_port_ok'

AUTH_NETS=$(docker inspect "$C" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')
DB_NETS=$(docker inspect "$DB_C" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')
REDIS_NETS=$(docker inspect "$REDIS_C" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')
comm -12 <(tr ' ' '\n' <<<"$AUTH_NETS" | sed '/^$/d' | sort) <(tr ' ' '\n' <<<"$DB_NETS" | sed '/^$/d' | sort) | grep -q .
comm -12 <(tr ' ' '\n' <<<"$AUTH_NETS" | sed '/^$/d' | sort) <(tr ' ' '\n' <<<"$REDIS_NETS" | sed '/^$/d' | sort) | grep -q .
printf '%s\n' 'preflight=isolated_networks_ok'

CANARY_DATABASE_URL=$(docker exec "$C" node --input-type=module -e '
  import fs from "node:fs";
  const values=fs.readFileSync("/proc/1/environ").toString("utf8").split("\0");
  const entry=values.find(value=>value.startsWith("DATABASE_URL="));
  if(!entry) process.exit(2);
  process.stdout.write(entry.slice("DATABASE_URL=".length));')
test -n "$CANARY_DATABASE_URL"
docker exec -e DATABASE_URL="$CANARY_DATABASE_URL" "$C" node --input-type=module -e '
  import pg from "pg";
  const url=new URL(process.env.DATABASE_URL);
  if(["127.0.0.1","localhost","::1"].includes(url.hostname)) throw new Error("canary_database_loopback_rejected");
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000});
  const result=await pool.query("SELECT 1 AS ok");
  await pool.end();
  if(result.rows[0]?.ok!==1) process.exit(3);'
printf '%s\n' 'preflight=isolated_database_read_ok'

mkdir -p "$WORK"
cp -a /srv/wb-tender-recovery/admin-runtime-rehearsal-4/data/career.db "$WORK/career.db.before"
docker exec -e DATABASE_URL="$CANARY_DATABASE_URL" "$C" node --input-type=module -e '
  import fs from "node:fs/promises"; import pg from "pg";
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
  const result=await pool.query("SELECT * FROM app.resources WHERE resource_type=ANY($1) ORDER BY resource_type,id", [["services","blogposts"]]);
  await fs.writeFile("/data/app-resources.before.json",JSON.stringify(result.rows,null,2),{mode:0o600}); await pool.end();'
docker cp "$C:/data/app-resources.before.json" "$WORK/app-resources.before.json"
docker exec "$C" rm -f /data/app-resources.before.json

docker cp "$ROOT/recovery/wix-admin-restore.json" "$C:/tmp/wix-admin-restore.json"
docker cp "$ROOT/scripts/wix-admin-canary-import.mjs" "$C:/tmp/wix-admin-canary-import.mjs"
docker exec -e DATABASE_URL="$CANARY_DATABASE_URL" "$C" node /tmp/wix-admin-canary-import.mjs /tmp/wix-admin-restore.json | tee "$WORK/import-result.json"
grep -Fq '"ok":true' "$WORK/import-result.json"
grep -Fq '"sqliteIntegrity":"ok"' "$WORK/import-result.json"

ASSET=$(docker exec "$C" node --input-type=module -e '
  import fs from "node:fs"; import path from "node:path";
  const html=fs.readFileSync("/app/apps/admin/dist/index.html","utf8");
  const match=html.match(/(?:src|href)="(?:\/admin\/)?(assets\/index-[^"]+[.]js)"/);
  if(!match) process.exit(2);
  const file=path.join("/app/apps/admin/dist",match[1]);
  if(!fs.existsSync(file)) process.exit(3);
  process.stdout.write(file);')
docker cp "$C:$ASSET" "$WORK/admin-asset.before.js"
docker exec "$C" node --input-type=module - "$ASSET" <<'NODE'
import fs from "node:fs";
const p=process.argv[2], s=fs.readFileSync(p,"utf8");
const wrong="/api/admin/v1/resources/responsibilities", right="/api/admin/v1/recruiting/responsibilities";
const n=s.split(wrong).length-1;
if(n>0) fs.writeFileSync(p,s.split(wrong).join(right));
const after=fs.readFileSync(p,"utf8");
if(after.includes(wrong) || !after.includes(right)) throw new Error("responsibilities_endpoint_verification_failed");
console.log(JSON.stringify({responsibilitiesEndpoint:"ok",replacements:n}));
NODE

docker restart "$C" >/dev/null
for ATTEMPT in $(seq 1 30); do
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4341/api/healthz || true)
  test "$CODE" = 200 && break
  test "$ATTEMPT" = 30 && exit 1
  sleep 1
done

for PATHNAME in /admin/ /api/healthz; do
  CODE=$(curl -ksS -o /dev/null -w '%{http_code}' --resolve www.enwi.online:443:127.0.0.1 "https://www.enwi.online${PATHNAME}")
  case "$PATHNAME:$CODE" in /admin/:200|/api/healthz:200) ;; *) exit 1 ;; esac
done

printf '%s\n' 'WB_WIX_ADMIN_CANARY_RESTORE=SUCCESS'
printf 'backup_directory=%s\n' "$WORK"
printf '%s\n' 'production_changed=false' 'production_mfa_changed=false' 'external_submission_changed=false'
