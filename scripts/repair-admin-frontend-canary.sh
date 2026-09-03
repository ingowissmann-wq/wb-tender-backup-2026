#!/usr/bin/env bash
set -Eeuo pipefail

C=wb-admin-rehearsal-auth-1
EXPECTED_IMAGE='sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86'
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/frontend-repair-${STAMP}"
INDEX=/app/apps/admin/dist/index.html

test "$(docker inspect "$C" --format '{{.State.Running}}')" = true
test "$(docker inspect "$C" --format '{{.Image}}')" = "$EXPECTED_IMAGE"
mkdir -p "$WORK"

CURRENT_ASSET=$(docker exec "$C" node --input-type=module -e '
  import fs from "node:fs"; import path from "node:path";
  const html=fs.readFileSync("/app/apps/admin/dist/index.html","utf8");
  const match=html.match(/(?:src|href)="(?:\/admin\/)?(assets\/index-[^"]+[.]js(?:[?][^"]*)?)"/);
  if(!match) process.exit(2);
  process.stdout.write(path.join("/app/apps/admin/dist",match[1].split("?")[0]));')
CURRENT_BASE=$(basename -- "$CURRENT_ASSET")
CANONICAL_BASE=$(printf '%s\n' "$CURRENT_BASE" | sed -E 's/-wbfix-[0-9]{8}T[0-9]{6}Z[.]js$/.js/')
CANONICAL_ASSET="$(dirname -- "$CURRENT_ASSET")/$CANONICAL_BASE"
docker exec "$C" test -f "$CANONICAL_ASSET"

docker cp "$C:$INDEX" "$WORK/index.before.html"
docker cp "$C:$CANONICAL_ASSET" "$WORK/canonical.before.js"

docker run --rm --network none --user 0:0 -i \
  -e WB_CANONICAL_BASE="$CANONICAL_BASE" -e WB_STAMP="$STAMP" \
  -v "$WORK:/work" --entrypoint node "$EXPECTED_IMAGE" --input-type=module - <<'NODE'
import fs from "node:fs";
const wrong="/api/admin/v1/resources/responsibilities";
const right="/api/admin/v1/recruiting/responsibilities";
const genericWrong='L.useEffect(()=>{x||le()},[d,x,M,C]),d==="responsibilities"';
const genericRight='L.useEffect(()=>{d!=="responsibilities"&&!x&&le()},[d,x,M,C]),d==="responsibilities"';
let source=fs.readFileSync("/work/canonical.before.js","utf8").split(wrong).join(right);
if(!source.includes(genericRight)) {
  const occurrences=source.split(genericWrong).length-1;
  if(occurrences!==1) throw new Error(`responsibilities_generic_loader_count:${occurrences}`);
  source=source.replace(genericWrong,genericRight);
}
if(source.includes(wrong)||!source.includes(right)||source.includes(genericWrong)||!source.includes(genericRight)) {
  throw new Error("responsibilities_endpoint_verification_failed");
}
fs.writeFileSync("/work/canonical.patched.js",source);

const html=fs.readFileSync("/work/index.before.html","utf8");
const pattern=/index-[^"?]+[.]js(?:[?][^"]*)?/g;
const matches=html.match(pattern)||[];
if(matches.length!==1) throw new Error(`admin_asset_reference_count:${matches.length}`);
fs.writeFileSync("/work/index.patched.html",html.replace(matches[0],`${process.env.WB_CANONICAL_BASE}?v=${process.env.WB_STAMP}`));
fs.writeFileSync("/work/index.rollback.html",html.replace(matches[0],process.env.WB_CANONICAL_BASE));
NODE

ROLLBACK=true
rollback() {
  STATUS=$?
  if test "$ROLLBACK" = true; then
    docker cp "$WORK/canonical.before.js" "$C:$CANONICAL_ASSET" >/dev/null 2>&1 || true
    docker cp "$WORK/index.rollback.html" "$C:$INDEX" >/dev/null 2>&1 || true
    printf '%s\n' 'WB_ADMIN_FRONTEND_REPAIR_ROLLBACK=SUCCESS'
  fi
  exit "$STATUS"
}
trap rollback EXIT

docker cp "$WORK/canonical.patched.js" "$C:$CANONICAL_ASSET"
docker cp "$WORK/index.patched.html" "$C:$INDEX"

docker exec -e WB_EXPECTED_REFERENCE="${CANONICAL_BASE}?v=${STAMP}" "$C" \
  node --input-type=module -e '
  import fs from "node:fs";
  const html=fs.readFileSync("/app/apps/admin/dist/index.html","utf8");
  const asset=fs.readFileSync(process.argv[1],"utf8");
  if(!html.includes(process.env.WB_EXPECTED_REFERENCE)) process.exit(2);
  if(asset.includes("/api/admin/v1/resources/responsibilities")) process.exit(3);
  if(!asset.includes("/api/admin/v1/recruiting/responsibilities")) process.exit(4);
  if(asset.includes(`L.useEffect(()=>{x||le()},[d,x,M,C]),d==="responsibilities"`)) process.exit(5);
  if(!asset.includes(`L.useEffect(()=>{d!=="responsibilities"&&!x&&le()},[d,x,M,C]),d==="responsibilities"`)) process.exit(6);' \
  "$CANONICAL_ASSET"

test "$(curl -ksS -o /dev/null -w '%{http_code}' "https://www.enwi.online/admin/assets/${CANONICAL_BASE}?v=${STAMP}")" = 200
test "$(curl -ksS -o /dev/null -w '%{http_code}' https://www.enwi.online/admin/)" = 200

ROLLBACK=false
trap - EXIT
printf '%s\n' 'WB_ADMIN_FRONTEND_REPAIR=SUCCESS'
printf 'asset=%s?v=%s\n' "$CANONICAL_BASE" "$STAMP"
printf 'backup_directory=%s\n' "$WORK"
printf '%s\n' 'database_changed=false' 'mfa_changed=false' 'external_submission_changed=false'
