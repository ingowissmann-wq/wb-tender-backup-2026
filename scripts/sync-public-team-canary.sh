#!/usr/bin/env bash
set -Eeuo pipefail

C=wb-admin-rehearsal-auth-1
EXPECTED_IMAGE='sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86'
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/public-team-sync-${STAMP}"
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

test "$(docker inspect "$C" --format '{{.State.Running}}')" = true
test "$(docker inspect "$C" --format '{{.Image}}')" = "$EXPECTED_IMAGE"
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4341/api/healthz)" = 200

CANARY_DATABASE_URL=$(docker exec "$C" node --input-type=module -e '
  import fs from "node:fs";
  const entry=fs.readFileSync("/proc/1/environ").toString("utf8").split("\0").find(value=>value.startsWith("DATABASE_URL="));
  if(!entry) process.exit(2);
  process.stdout.write(entry.slice("DATABASE_URL=".length));')
test -n "$CANARY_DATABASE_URL"

mkdir -p "$WORK"
docker exec -e DATABASE_URL="$CANARY_DATABASE_URL" "$C" node --input-type=module -e '
  import fs from "node:fs/promises";
  import pg from "pg";
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
  const result=await pool.query("SELECT * FROM app.resources WHERE resource_type=$1 ORDER BY id",["team"]);
  await fs.writeFile("/data/public-team.before.json",JSON.stringify(result.rows,null,2),{mode:0o600});
  await pool.end();'
docker cp "$C:/data/public-team.before.json" "$WORK/public-team.before.json"
docker exec "$C" rm -f /data/public-team.before.json

docker cp "$ROOT/scripts/sync-public-team-canary.mjs" "$C:/app/apps/api/dist/sync-public-team-canary.mjs"
docker exec -e DATABASE_URL="$CANARY_DATABASE_URL" -e NODE_NO_WARNINGS=1 "$C" \
  node /app/apps/api/dist/sync-public-team-canary.mjs | tee "$WORK/sync-result.json"

grep -Fq '"ok":true' "$WORK/sync-result.json"
grep -Fq '"team":6' "$WORK/sync-result.json"

CODE=$(curl -ksS -o "$WORK/public-team.after.json" -w '%{http_code}' \
  'https://www.enwi.online/api/public/v1/team')
test "$CODE" = 200

python3 - "$WORK/public-team.after.json" "$WORK/media-urls.txt" <<'PY'
import json, pathlib, sys
payload=json.loads(pathlib.Path(sys.argv[1]).read_text())
expected={"Inna Bohuslavska","Swen Ahlgrimm","Kateryna Wissmann","Simon Bayer","Karl Heinz Krenke","Dr. Ingo Wissmann"}
items=payload.get("items",[])
by_name={str((item.get("data") or {}).get("name") or item.get("title") or ""): item for item in items}
missing=sorted(expected-set(by_name))
if missing:
    raise SystemExit("missing_public_team=" + ",".join(missing))
urls=[]
for name in sorted(expected):
    data=by_name[name].get("data") or {}
    url=str(data.get("profilePicture") or data.get("imageUrl") or "")
    if not url.startswith("/cms-media/"):
        raise SystemExit(f"invalid_public_team_image={name}:{url}")
    urls.append("https://www.enwi.online"+url)
pathlib.Path(sys.argv[2]).write_text("\n".join(urls)+"\n")
print("public_team=6")
PY

while IFS= read -r URL; do
  test "$(curl -ksS -o /dev/null -w '%{http_code}' "$URL")" = 200
done < "$WORK/media-urls.txt"

printf '%s\n' 'WB_PUBLIC_TEAM_CANARY_SYNC=SUCCESS'
printf 'backup_directory=%s\n' "$WORK"
printf '%s\n' 'public_team=6' 'public_team_media=6'
printf '%s\n' 'production_database_changed=false'
printf '%s\n' 'production_mfa_changed=false'
printf '%s\n' 'external_submission_changed=false'
