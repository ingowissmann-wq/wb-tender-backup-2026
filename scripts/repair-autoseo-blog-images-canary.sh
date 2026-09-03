#!/usr/bin/env bash
set -Eeuo pipefail

C=wb-admin-rehearsal-auth-1
DB=wb-admin-rehearsal-db-1
REDIS=wb-admin-rehearsal-redis-1
EXPECTED_IMAGE='sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86'
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/blog-image-repair-${STAMP}"
REMOTE_SCRIPT=/app/apps/api/dist/repair-autoseo-blog-images-canary.mjs
REMOTE_BACKUP=/tmp/wb-autoseo-blog-images.before.json

mkdir -p "$WORK"

test "$(docker inspect "$C" --format '{{.State.Running}}')" = true
test "$(docker inspect "$C" --format '{{.Image}}')" = "$EXPECTED_IMAGE"
test "$(docker inspect "$DB" --format '{{.State.Running}}')" = true
test "$(docker inspect "$REDIS" --format '{{.State.Running}}')" = true
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4341/api/healthz)" = 200

AUTH_NETWORKS=$(docker inspect "$C" --format '{{range $key,$value := .NetworkSettings.Networks}}{{$key}} {{end}}')
DB_NETWORKS=$(docker inspect "$DB" --format '{{range $key,$value := .NetworkSettings.Networks}}{{$key}} {{end}}')
case "$AUTH_NETWORKS" in *wb-admin-rehearsal*) ;; *) exit 41 ;; esac
case "$DB_NETWORKS" in *wb-admin-rehearsal*) ;; *) exit 42 ;; esac

docker cp "$(dirname "$0")/repair-autoseo-blog-images-canary.mjs" "$C:$REMOTE_SCRIPT"
docker exec "$C" node --check "$REMOTE_SCRIPT"
docker exec "$C" rm -f "$REMOTE_BACKUP"

REPORT=$(docker exec "$C" node "$REMOTE_SCRIPT" "$REMOTE_BACKUP")
printf '%s\n' "$REPORT"
printf '%s\n' "$REPORT" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'
printf '%s\n' "$REPORT" | grep -Eq '"linked"[[:space:]]*:[[:space:]]*(1[0-9]|[2-9][0-9])'

docker cp "$C:$REMOTE_BACKUP" "$WORK/blog-images.before.json"
docker exec "$C" rm -f "$REMOTE_SCRIPT" "$REMOTE_BACKUP"

test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4341/api/healthz)" = 200
PUBLIC_JSON=$(curl -ksS 'https://www.enwi.online/api/public/v1/blogposts?page=1&pageSize=25')
printf '%s' "$PUBLIC_JSON" >"$WORK/public-blogposts.after.json"
printf '%s' "$PUBLIC_JSON" | grep -q '/cms-media/'

printf '%s\n' 'WB_AUTOSEO_BLOG_IMAGES_CANARY=SUCCESS'
printf 'backup_directory=%s\n' "$WORK"
printf '%s\n' 'production_database_changed=false'
printf '%s\n' 'production_mfa_changed=false'
printf '%s\n' 'external_submission_changed=false'
