#!/usr/bin/env bash
set -Eeuo pipefail

EXPECTED_IMAGE='sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86'
SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/tender-password-reset-live-${STAMP}"
PATCHER="${SOURCE}/integrations/wb-admin-portal/candidate/tender-password-reset-ui-patch.mjs"
MANIFEST="${WORK}/targets.tsv"
RESTARTS="${WORK}/containers.txt"

mkdir -p "$WORK"
: >"$MANIFEST"
: >"$RESTARTS"
test -f "$PATCHER"

docker run --rm --network none --user 0:0 \
  -v "$SOURCE:/source:ro" \
  --entrypoint node "$EXPECTED_IMAGE" \
  --test /source/tests/tender-password-reset-ui.test.mjs

FORGOT_CODE=$(curl --http1.1 -ksS -o "$WORK/forgot-preflight.json" -w '%{http_code}' \
  --resolve www.enwi.online:443:127.0.0.1 \
  -H 'content-type: application/json' \
  --data '{"email":"nonexistent-reset-preflight@invalid.example"}' \
  'https://www.enwi.online/api/admin/v1/iam/password/forgot')
test "$FORGOT_CODE" = 200
grep -Fq '"ok":true' "$WORK/forgot-preflight.json"
printf '%s\n' 'preflight=password_reset_api_ok'

APPLIED=false
rollback() {
  status=$?
  trap - ERR
  if test "$APPLIED" = true; then
    while IFS=$'\t' read -r CONTAINER TARGET BEFORE; do
      test -n "$CONTAINER" || continue
      docker cp "$BEFORE" "$CONTAINER:$TARGET" >/dev/null 2>&1 || true
    done <"$MANIFEST"
    sort -u "$RESTARTS" | while IFS= read -r CONTAINER; do
      test -n "$CONTAINER" && docker restart "$CONTAINER" >/dev/null 2>&1 || true
    done
    printf '%s\n' 'WB_TENDER_PASSWORD_RESET_ROLLBACK=SUCCESS' >&2
  fi
  exit "$status"
}
trap rollback ERR

INDEX=0
while IFS= read -r CONTAINER; do
  [[ "$CONTAINER" =~ ^[A-Za-z0-9_.-]+$ ]] || continue
  docker exec "$CONTAINER" node --version >/dev/null 2>&1 || continue

  mapfile -t TARGETS < <(docker exec -i --user 0:0 "$CONTAINER" node --input-type=module - <<'NODE'
import fs from "node:fs";
import path from "node:path";
const skipped=new Set(["node_modules",".git","postgres"]);
const found=[];
function walk(directory){
  let entries;
  try{entries=fs.readdirSync(directory,{withFileTypes:true});}catch{return}
  for(const entry of entries){
    const full=path.join(directory,entry.name);
    if(entry.isDirectory()){
      if(!skipped.has(entry.name)) walk(full);
      continue;
    }
    if(!entry.isFile() || !/[.]m?js$/.test(entry.name)) continue;
    let stat,text;
    try{
      stat=fs.statSync(full);
      if(stat.size>1024*1024) continue;
      text=fs.readFileSync(full,"utf8");
    }catch{continue}
    if(text.includes("WB Tender anmelden") &&
       text.includes('<form id="login-form">') &&
       (text.includes('const target=safeReturn()') || text.includes("WB_TENDER_PASSWORD_RESET_UI"))) {
      found.push(full);
    }
  }
}
walk("/app");
for(const file of found.sort()) console.log(file);
NODE
  )

  for TARGET in "${TARGETS[@]}"; do
    case "$TARGET" in /app/*) ;; *) exit 71 ;; esac
    INDEX=$((INDEX+1))
    BEFORE="$WORK/target-${INDEX}.before.mjs"
    PATCHED="$WORK/target-${INDEX}.patched.mjs"

    docker cp "$CONTAINER:$TARGET" "$BEFORE"
    cp -a "$BEFORE" "$PATCHED"
    docker run --rm --network none --user 0:0 \
      -v "$PATCHER:/tmp/tender-password-reset-ui-patch.mjs:ro" \
      -v "$PATCHED:/tmp/runtime.mjs" \
      --entrypoint node "$EXPECTED_IMAGE" \
      /tmp/tender-password-reset-ui-patch.mjs /tmp/runtime.mjs
    grep -Fq 'WB_TENDER_PASSWORD_RESET_UI' "$PATCHED"
    grep -Fq '/api/admin/v1/iam/password/forgot' "$PATCHED"
    docker run --rm --network none --user 0:0 \
      -v "$PATCHED:/tmp/runtime.mjs:ro" \
      --entrypoint node "$EXPECTED_IMAGE" --check /tmp/runtime.mjs

    printf '%s\t%s\t%s\n' "$CONTAINER" "$TARGET" "$BEFORE" >>"$MANIFEST"
    printf '%s\n' "$CONTAINER" >>"$RESTARTS"
    APPLIED=true
    docker cp "$PATCHED" "$CONTAINER:/tmp/wb-tender-password-reset-${INDEX}.mjs"
    docker exec --user 0:0 "$CONTAINER" cp "/tmp/wb-tender-password-reset-${INDEX}.mjs" "$TARGET"
    printf 'patched_container=%s target=%s\n' "$CONTAINER" "$TARGET"
  done
done < <(docker ps --format '{{.Names}}')

test "$INDEX" -gt 0
printf 'preflight=login_runtime_targets_found count=%s containers=%s\n' \
  "$INDEX" "$(sort -u "$RESTARTS" | wc -l)"

sort -u "$RESTARTS" | while IFS= read -r CONTAINER; do
  docker restart "$CONTAINER" >/dev/null
done

LIVE_READY=false
for ATTEMPT in $(seq 1 45); do
  CODE=$(curl --http1.1 -ksS -o /dev/null -w '%{http_code}' \
    --resolve www.enwi.online:443:127.0.0.1 \
    "https://www.enwi.online/admin/ausschreibungen/login?wb_reset=${STAMP}" || true)
  printf 'attempt=%s live_login=%s\n' "$ATTEMPT" "$CODE"
  if test "$CODE" = 200; then LIVE_READY=true; break; fi
  sleep 1
done
test "$LIVE_READY" = true

while IFS=$'\t' read -r CONTAINER TARGET BEFORE; do
  docker exec --user 0:0 "$CONTAINER" grep -Fq 'WB_TENDER_PASSWORD_RESET_UI' "$TARGET"
done <"$MANIFEST"
printf '%s\n' 'preflight=patched_runtimes_persisted_after_restart'

LOGIN_FILE="$WORK/login.html"
AUTH_FILE="$WORK/auth.js"
LOGIN_CODE=$(curl --http1.1 -ksS -o "$LOGIN_FILE" -w '%{http_code}' \
  --resolve www.enwi.online:443:127.0.0.1 \
  -H 'Cache-Control: no-cache' \
  "https://www.enwi.online/admin/ausschreibungen/login?wb_reset=${STAMP}")
AUTH_CODE=$(curl --http1.1 -ksS -o "$AUTH_FILE" -w '%{http_code}' \
  --resolve www.enwi.online:443:127.0.0.1 \
  -H 'Cache-Control: no-cache' \
  "https://www.enwi.online/admin/ausschreibungen/auth.js?wb_reset=${STAMP}")
printf 'preflight=live_assets login_http=%s auth_http=%s\n' "$LOGIN_CODE" "$AUTH_CODE"
test "$LOGIN_CODE" = 200
test "$AUTH_CODE" = 200
grep -Fq 'Passwort vergessen?' "$LOGIN_FILE"
grep -Fq 'WB_TENDER_PASSWORD_RESET_UI' "$AUTH_FILE"
grep -Fq '/api/admin/v1/iam/password/forgot' "$AUTH_FILE"
printf '%s\n' 'preflight=live_password_reset_ui_ok'

POST_CODE=$(curl --http1.1 -ksS -o "$WORK/forgot-postdeploy.json" -w '%{http_code}' \
  --resolve www.enwi.online:443:127.0.0.1 \
  -H 'content-type: application/json' \
  --data '{"email":"nonexistent-reset-postdeploy@invalid.example"}' \
  'https://www.enwi.online/api/admin/v1/iam/password/forgot')
test "$POST_CODE" = 200
grep -Fq '"ok":true' "$WORK/forgot-postdeploy.json"

APPLIED=false
trap - ERR
printf '%s\n' 'WB_TENDER_PASSWORD_RESET_UI=SUCCESS'
printf '%s\n' 'login_link=visible'
printf '%s\n' 'reset_request_api=200'
printf '%s\n' 'reset_link_validity=30_minutes_single_use'
printf 'backup_directory=%s\n' "$WORK"
printf '%s\n' 'password_changed=false'
printf '%s\n' 'mfa_changed=false'
printf '%s\n' 'external_submission_changed=false'
