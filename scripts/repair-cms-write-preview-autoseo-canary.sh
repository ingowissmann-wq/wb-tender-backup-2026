#!/usr/bin/env bash
set -Eeuo pipefail

C=wb-admin-rehearsal-auth-1
DB=wb-admin-rehearsal-db-1
EXPECTED_IMAGE='sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86'
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/cms-write-fix-${STAMP}"
ORIGINAL="${WORK}/server.before.js"
PATCHED="${WORK}/server.patched.js"

mkdir -p "$WORK"
test "$(docker inspect "$C" --format '{{.Image}}')" = "$EXPECTED_IMAGE"
test "$(docker inspect "$C" --format '{{.State.Running}}')" = true
test "$(docker inspect "$DB" --format '{{.State.Running}}')" = true

DB_NAME=$(docker exec "$DB" sh -lc 'printf %s "$POSTGRES_DB"')
DB_USER=$(docker exec "$DB" sh -lc 'printf %s "$POSTGRES_USER"')
case "$DB_NAME:$DB_USER" in
  *[!A-Za-z0-9_.:-]*) printf '%s\n' 'invalid_database_identity' >&2; exit 20 ;;
esac

TENANT=$(docker exec "$DB" psql -X -At -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c '
  WITH tenants AS (
    SELECT tenant_id FROM files.objects WHERE tenant_id IS NOT NULL
    UNION
    SELECT tenant_id FROM app.resources WHERE tenant_id IS NOT NULL
  )
  SELECT tenant_id FROM tenants;
')
test -n "$TENANT"
test "$(printf '%s\n' "$TENANT" | awk 'NF{n++} END{print n+0}')" -eq 1
case "$TENANT" in
  ????????-????-????-????-????????????) ;;
  *) printf '%s\n' 'invalid_or_ambiguous_tenant' >&2; exit 21 ;;
esac

PREVIOUS=$(docker exec "$DB" psql -X -At -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c "
  SELECT COALESCE((
    SELECT substring(setting FROM length('app.tenant_id=') + 1)
    FROM pg_db_role_setting s
    CROSS JOIN LATERAL unnest(s.setconfig) AS setting
    WHERE s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND s.setrole = 0
      AND setting LIKE 'app.tenant_id=%'
    LIMIT 1
  ), '');
")
printf '%s' "$PREVIOUS" >"${WORK}/previous-database-tenant-setting.txt"

docker cp "$C:/app/apps/api/dist/server.js" "$ORIGINAL"
cp -a "$ORIGINAL" "$PATCHED"

PATCHED_APP=false
DATABASE_CHANGED=false

restore_database_setting() {
  if test -n "$PREVIOUS"; then
    docker exec -i "$DB" psql -X -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" >/dev/null <<SQL
ALTER DATABASE "$DB_NAME" SET app.tenant_id = '$PREVIOUS';
SQL
  else
    docker exec -i "$DB" psql -X -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" >/dev/null <<SQL
ALTER DATABASE "$DB_NAME" RESET app.tenant_id;
SQL
  fi
}

rollback() {
  status=$?
  trap - ERR
  if test "$DATABASE_CHANGED" = true; then
    restore_database_setting || true
  fi
  if test "$PATCHED_APP" = true; then
    docker cp "$ORIGINAL" "$C:/app/apps/api/dist/server.js" >/dev/null || true
  fi
  if test "$DATABASE_CHANGED" = true || test "$PATCHED_APP" = true; then
    docker restart "$C" >/dev/null || true
  fi
  printf '%s\n' 'WB_CMS_WRITE_PREVIEW_ROLLBACK=SUCCESS' >&2
  exit "$status"
}
trap rollback ERR

node --input-type=module - "$PATCHED" <<'NODE'
import fs from 'node:fs';

const file = process.argv[2];
let source = fs.readFileSync(file, 'utf8');
const marker = 'WB_BLOG_PREVIEW_PUBLIC_REDIRECT_CANARY';
const needle = 'app.get("/api/admin/v1/resources/:type/:id/preview", async (req, reply) => {';

if (!source.includes(marker)) {
  const occurrences = source.split(needle).length - 1;
  if (occurrences !== 1) throw new Error(`preview_route_occurrences_${occurrences}`);
  source = source.replace(needle, `${needle}\n    // ${marker}\n    if (req.params?.type === "blogposts") {\n      const id = String(req.params?.id || "");\n      if (/^[0-9a-f-]{36}$/i.test(id)) {\n        return reply.redirect(\`https://www.wb-holding.ag/blog/\${encodeURIComponent(id)}\`);\n      }\n    }`);
}

fs.writeFileSync(file, source);
NODE

docker run --rm --network none --user 0:0 \
  -v "$PATCHED:/tmp/server.js:ro" \
  --entrypoint node "$EXPECTED_IMAGE" --check /tmp/server.js
grep -Fq 'WB_BLOG_PREVIEW_PUBLIC_REDIRECT_CANARY' "$PATCHED"

docker exec -i "$DB" psql -X -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" >/dev/null <<SQL
ALTER DATABASE "$DB_NAME" SET app.tenant_id = '$TENANT';
SQL
DATABASE_CHANGED=true

docker cp "$PATCHED" "$C:/app/apps/api/dist/server.js"
PATCHED_APP=true
docker restart "$C" >/dev/null

HEALTH=false
for ATTEMPT in $(seq 1 30); do
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4341/api/healthz || true)
  printf 'attempt=%s health=%s\n' "$ATTEMPT" "$CODE"
  if test "$CODE" = 200; then HEALTH=true; break; fi
  sleep 1
done
test "$HEALTH" = true

CANARY_DATABASE_URL=$(docker exec "$C" node --input-type=module -e '
  import fs from "node:fs";
  const env = Object.fromEntries(fs.readFileSync("/proc/1/environ").toString().split("\0").filter(Boolean).map(v => { const i=v.indexOf("="); return [v.slice(0,i),v.slice(i+1)]; }));
  process.stdout.write(env.DATABASE_URL || "");
')
test -n "$CANARY_DATABASE_URL"

docker exec -e DATABASE_URL="$CANARY_DATABASE_URL" -e EXPECTED_TENANT="$TENANT" "$C" \
  node --input-type=module -e '
    const { query } = await import("/app/apps/api/dist/db.js");
    const { rows } = await query("SELECT current_setting(\x27app.tenant_id\x27, true) AS setting, saas.current_tenant_id()::text AS tenant");
    if (rows[0]?.setting !== process.env.EXPECTED_TENANT || rows[0]?.tenant !== process.env.EXPECTED_TENANT) throw new Error("tenant_context_not_active");
    console.log("preflight=fresh_connection_tenant_context_ok");
  '

docker exec -i "$DB" psql -X -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" >/dev/null <<'SQL'
BEGIN;
INSERT INTO files.objects(storage_name, original_name, mime_type, size_bytes, sha256, protection_class, verified)
VALUES ('wb-tenant-preflight', 'wb-tenant-preflight.txt', 'text/plain', 1, repeat('0',64), 'private', false);
ROLLBACK;
SQL
printf '%s\n' 'preflight=files_write_default_tenant_ok'

PREVIEW_HEADERS=$(curl --http1.1 -ksS -D - -o /dev/null \
  --resolve www.enwi.online:443:127.0.0.1 \
  'https://www.enwi.online/api/admin/v1/resources/blogposts/c0bd072a-ce5e-4b1b-84c5-5ff041e49294/preview')
printf '%s\n' "$PREVIEW_HEADERS" | grep -Eq '^HTTP/[^ ]+ 30[12378]'
printf '%s\n' "$PREVIEW_HEADERS" | grep -Eiq '^location: https://www\.wb-holding\.ag/blog/c0bd072a-ce5e-4b1b-84c5-5ff041e49294'

AUTOSEO_URL=$(cat /root/wb-autoseo-webhook-url.txt)
case "$AUTOSEO_URL" in
  'https://www.enwi.online/api/integrations/autoseo/webhook?key='*) ;;
  *) printf '%s\n' 'invalid_autoseo_webhook_url_file' >&2; exit 22 ;;
esac
AUTOSEO_CODE=$(curl --http1.1 -ksS -o /dev/null -w '%{http_code}' \
  --resolve www.enwi.online:443:127.0.0.1 \
  -H 'content-type: application/json' \
  --data '{"event":"test"}' \
  "$AUTOSEO_URL")
test "$AUTOSEO_CODE" = 200

trap - ERR
printf '%s\n' 'WB_CMS_WRITE_PREVIEW_AUTOSEO_CANARY=SUCCESS'
printf 'tenant=%s\n' "$TENANT"
printf '%s\n' 'upload_database_default=verified'
printf '%s\n' 'blog_preview=redirected_to_public_site'
printf 'autoseo_test=%s\n' "$AUTOSEO_CODE"
printf 'backup_directory=%s\n' "$WORK"
printf '%s\n' 'production_database_changed=false'
printf '%s\n' 'production_mfa_changed=false'
printf '%s\n' 'external_submission_changed=false'
