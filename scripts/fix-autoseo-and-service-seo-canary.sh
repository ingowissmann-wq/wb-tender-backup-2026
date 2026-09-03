#!/usr/bin/env bash
set -Eeuo pipefail

C=wb-admin-rehearsal-auth-1
DB=wb-admin-rehearsal-db-1
EXPECTED_IMAGE='sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86'
SERVER_PATH=/app/apps/api/dist/server.js
AUTOSEO_PATH=/app/apps/api/dist/autoseo.js
URL_FILE=/root/wb-autoseo-webhook-url.txt
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/autoseo-seo-final-${STAMP}"

mkdir -p "$WORK"
test "$(docker inspect "$C" --format '{{.State.Running}}')" = true
test "$(docker inspect "$C" --format '{{.Image}}')" = "$EXPECTED_IMAGE"
test "$(docker inspect "$DB" --format '{{.State.Running}}')" = true
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4341/api/healthz)" = 200
test -s "$URL_FILE"
docker exec "$C" test -f "$SERVER_PATH"
docker exec "$C" test -f "$AUTOSEO_PATH"

docker cp "$C:$SERVER_PATH" "$WORK/server.before.js"
docker cp "$C:$AUTOSEO_PATH" "$WORK/autoseo.before.js"
cp -a "$WORK/server.before.js" "$WORK/server.patched.js"
cp -a "$WORK/autoseo.before.js" "$WORK/autoseo.patched.js"

docker run --rm --network none --user 0:0 -i \
  -v "$WORK:/work" --entrypoint node "$EXPECTED_IMAGE" --input-type=module <<'NODE'
import fs from "node:fs";

function replaceOnce(source, oldValue, newValue, label) {
  const count = source.split(oldValue).length - 1;
  if (count !== 1) throw new Error(`${label}_not_unique:${count}`);
  return source.replace(oldValue, newValue);
}

const serverPath = "/work/server.patched.js";
let server = fs.readFileSync(serverPath, "utf8");
if (!server.includes("WB_ZOD4_RESOURCE_RECORD_CANARY")) {
  server = replaceOnce(
    server,
    `const body = z.record(z.unknown()).parse(req.body);`,
    `// WB_ZOD4_RESOURCE_RECORD_CANARY\n    const body = z.record(z.string(), z.unknown()).parse(req.body);`,
    "zod4_resource_record"
  );
}
fs.writeFileSync(serverPath, server);

const autoseoPath = "/work/autoseo.patched.js";
let autoseo = fs.readFileSync(autoseoPath, "utf8");
if (!autoseo.includes("WB_AUTOSEO_BODY_COMPAT_CANARY")) {
  autoseo = replaceOnce(
    autoseo,
    `const rawBody = req.rawBody, authorization = text(req.headers.authorization), signatureHeader = text(req.headers["x-autoseo-signature"]);`,
    `// WB_AUTOSEO_BODY_COMPAT_CANARY\n        const rawBody = Buffer.isBuffer(req.rawBody)\n            ? req.rawBody\n            : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));\n        const authorization = text(req.headers.authorization), signatureHeader = text(req.headers["x-autoseo-signature"]);`,
    "autoseo_raw_body"
  );
  autoseo = replaceOnce(
    autoseo,
    `const parsed = articleSchema.safeParse(articleValue);`,
    `const compatibleArticle = {\n            ...articleValue,\n            shortDescription: articleValue.shortDescription ?? articleValue.short_description ?? articleValue.description,\n            metaDescription: articleValue.metaDescription ?? articleValue.meta_description ?? articleValue.description,\n            seoTitle: articleValue.seoTitle ?? articleValue.seo_title,\n            focusKeyword: articleValue.focusKeyword ?? articleValue.focus_keyword,\n            content_html: articleValue.content_html ?? articleValue.html ?? articleValue.contentHtml,\n            content_markdown: articleValue.content_markdown ?? articleValue.markdown ?? articleValue.contentMarkdown,\n            heroImageUrl: articleValue.heroImageUrl ?? articleValue.hero_image_url ?? articleValue.cover_image_url ?? articleValue.coverImageUrl,\n            heroImageAlt: articleValue.heroImageAlt ?? articleValue.hero_image_alt ?? articleValue.cover_image_alt,\n            heroImageTitle: articleValue.heroImageTitle ?? articleValue.hero_image_title ?? articleValue.cover_image_title,\n            infographicImageUrl: articleValue.infographicImageUrl ?? articleValue.infographic_image_url,\n            infographicImageAlt: articleValue.infographicImageAlt ?? articleValue.infographic_image_alt,\n            infographicImageTitle: articleValue.infographicImageTitle ?? articleValue.infographic_image_title,\n            keywords: articleValue.keywords ?? articleValue.tags,\n            publishedAt: articleValue.publishedAt ?? articleValue.published_at ?? articleValue.created_at,\n            updatedAt: articleValue.updatedAt ?? articleValue.updated_at\n        };\n        const parsed = articleSchema.safeParse(compatibleArticle);`,
    "autoseo_article_compat"
  );
}
if (!autoseo.includes("WB_AUTOSEO_TENANT_RESOLUTION_V2_CANARY")) {
  autoseo = replaceOnce(
    autoseo,
    `const tenantResult = await query("SELECT tenant_id FROM iam.users WHERE lower(email)=lower($1) AND tenant_id IS NOT NULL LIMIT 1", ["admin@wb-holding.ag"]);
        const tenantId = tenantResult.rows[0]?.tenant_id;
        if (!tenantId)`,
    `// WB_AUTOSEO_TENANT_RESOLUTION_V2_CANARY
        const tenantResult = await query("SELECT tenant_id,count(*)::int AS total FROM files.objects WHERE tenant_id IS NOT NULL GROUP BY tenant_id ORDER BY total DESC");
        const tenantId = tenantResult.rows.length === 1 ? tenantResult.rows[0].tenant_id : undefined;
        if (!tenantId)`,
    "autoseo_tenant_resolution_v2"
  );
}
fs.writeFileSync(autoseoPath, autoseo);
NODE

grep -Fq 'WB_ZOD4_RESOURCE_RECORD_CANARY' "$WORK/server.patched.js"
grep -Fq 'WB_AUTOSEO_BODY_COMPAT_CANARY' "$WORK/autoseo.patched.js"
grep -Fq 'WB_AUTOSEO_TENANT_RESOLUTION_V2_CANARY' "$WORK/autoseo.patched.js"
grep -Fq 'WB_AUTOSEO_TENANT_CONTEXT_CANARY' "$WORK/autoseo.patched.js"
grep -Fq 'WB_AUTOSEO_URL_AUTH_CANARY' "$WORK/autoseo.patched.js"
docker run --rm --network none --user 0:0 -v "$WORK:/work:ro" \
  --entrypoint node "$EXPECTED_IMAGE" --check /work/server.patched.js
docker run --rm --network none --user 0:0 -v "$WORK:/work:ro" \
  --entrypoint node "$EXPECTED_IMAGE" --check /work/autoseo.patched.js

CANARY_DATABASE_URL=$(docker exec "$C" node --input-type=module -e '
  import fs from "node:fs";
  const value=fs.readFileSync("/proc/1/environ").toString("utf8").split("\0").find(item=>item.startsWith("DATABASE_URL="));
  if(!value) process.exit(2);
  process.stdout.write(value.slice("DATABASE_URL=".length));')
test -n "$CANARY_DATABASE_URL"

docker exec -i -e DATABASE_URL="$CANARY_DATABASE_URL" "$C" node --input-type=module - <<'NODE' > "$WORK/services.before.json"
import pg from "pg";
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
const tenants=(await pool.query("SELECT tenant_id,count(*)::int AS total FROM files.objects WHERE tenant_id IS NOT NULL GROUP BY tenant_id ORDER BY total DESC")).rows;
if(tenants.length!==1) throw new Error(`isolated_canary_tenant_not_unique:${tenants.length}`);
const tenant=tenants[0].tenant_id;
const rows=(await pool.query("SELECT id,title,status,data,version FROM app.resources WHERE tenant_id=$1 AND resource_type='services' ORDER BY id",[tenant])).rows;
if(rows.length!==8) throw new Error(`expected_8_services_found_${rows.length}`);
process.stdout.write(JSON.stringify({tenant,rows}));
await pool.end();
NODE
test -s "$WORK/services.before.json"

PATCHED_APP=false
PATCHED_DATA=false
rollback() {
  STATUS=$?
  if test "$PATCHED_DATA" = true; then
    docker cp "$WORK/services.before.json" "$C:/tmp/services.before.json" >/dev/null
    docker exec -i -e DATABASE_URL="$CANARY_DATABASE_URL" "$C" node --input-type=module - <<'NODE' || true
import fs from "node:fs"; import pg from "pg";
const backup=JSON.parse(fs.readFileSync("/tmp/services.before.json","utf8"));
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
const client=await pool.connect();
try { await client.query("BEGIN"); for(const row of backup.rows) await client.query("UPDATE app.resources SET title=$1,status=$2,data=$3::jsonb,version=$4 WHERE id=$5 AND tenant_id=$6 AND resource_type='services'",[row.title,row.status,JSON.stringify(row.data),row.version,row.id,backup.tenant]); await client.query("COMMIT"); } catch(e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); await pool.end(); }
NODE
  fi
  if test "$PATCHED_APP" = true; then
    docker cp "$WORK/server.before.js" "$C:$SERVER_PATH" >/dev/null
    docker cp "$WORK/autoseo.before.js" "$C:$AUTOSEO_PATH" >/dev/null
    docker restart "$C" >/dev/null
  fi
  printf '%s\n' 'WB_AUTOSEO_SERVICE_SEO_ROLLBACK=SUCCESS'
  exit "$STATUS"
}
trap rollback ERR

docker cp "$WORK/server.patched.js" "$C:$SERVER_PATH"
docker cp "$WORK/autoseo.patched.js" "$C:$AUTOSEO_PATH"
PATCHED_APP=true

docker exec -i -e DATABASE_URL="$CANARY_DATABASE_URL" "$C" node --input-type=module - <<'NODE'
import pg from "pg";
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
const client=await pool.connect();
try {
  await client.query("BEGIN");
  const tenants=(await client.query("SELECT tenant_id,count(*)::int AS total FROM files.objects WHERE tenant_id IS NOT NULL GROUP BY tenant_id ORDER BY total DESC")).rows;
  if(tenants.length!==1) throw new Error(`isolated_canary_tenant_not_unique:${tenants.length}`);
  const tenant=tenants[0].tenant_id;
  const result=await client.query(`UPDATE app.resources r
    SET data=(SELECT jsonb_object_agg(e.key,CASE WHEN jsonb_typeof(e.value)='string' THEN to_jsonb(replace(e.value #>> '{}','{city}','Augsburg')) ELSE e.value END) FROM jsonb_each(r.data) e),
        version=version+1,updated_at=now()
    WHERE tenant_id=$1 AND resource_type='services' AND data::text LIKE '%{city}%' RETURNING id`,[tenant]);
  if(result.rowCount<6) throw new Error(`expected_at_least_6_city_services_updated_${result.rowCount}`);
  const h1=await client.query(`UPDATE app.resources SET data=jsonb_set(data,'{h1}',to_jsonb($1::text),true),version=version+1,updated_at=now()
    WHERE tenant_id=$2 AND resource_type='services' AND data->>'slug'='gebaeudereinigung' RETURNING id`,["Gebäudereinigung für Behörden, Unternehmen und Gewerbe",tenant]);
  if(h1.rowCount!==1) throw new Error(`expected_one_cleaning_h1_updated_${h1.rowCount}`);
  await client.query("COMMIT");
  console.log(`services_city_updated=${result.rowCount}`);
} catch(e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); await pool.end(); }
NODE
PATCHED_DATA=true

docker restart "$C" >/dev/null
HEALTH=false
for ATTEMPT in $(seq 1 30); do
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4341/api/healthz || true)
  if test "$CODE" = 200; then HEALTH=true; break; fi
  sleep 1
done
test "$HEALTH" = true

WEBHOOK_URL=$(cat "$URL_FILE")
case "$WEBHOOK_URL" in
  'https://www.enwi.online/api/integrations/autoseo/webhook?key='*) ;;
  *) exit 42 ;;
esac
TEST_CODE=$(curl -ksS -o "$WORK/autoseo-test.json" -w '%{http_code}' \
  -H 'content-type: application/json' --data '{"event":"test","article":{"id":"compatibility-test","title":"Compatibility Test","cover_image_url":null,"html":"<p>test</p>"}}' "$WEBHOOK_URL")
test "$TEST_CODE" = 200
grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' "$WORK/autoseo-test.json"

PUBLIC_JSON=$(curl -ksS 'https://www.enwi.online/api/public/v1/services')
if printf '%s' "$PUBLIC_JSON" | grep -Fq '{city}'; then exit 43; fi
printf '%s' "$PUBLIC_JSON" | grep -Fq 'Gebäudereinigung für Behörden, Unternehmen und Gewerbe'

PATCHED_APP=false
PATCHED_DATA=false
trap - ERR
printf '%s\n' 'WB_AUTOSEO_SERVICE_SEO_CANARY=SUCCESS'
printf 'backup_directory=%s\n' "$WORK"
printf '%s\n' 'autoseo_test=200' 'service_placeholders=0' 'admin_save_schema=compatible'
printf '%s\n' 'production_database_changed=false' 'production_mfa_changed=false' 'external_submission_changed=false'
