#!/usr/bin/env bash
set -Eeuo pipefail

C=wb-admin-rehearsal-auth-1
EXPECTED_IMAGE='sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86'
AUTOSEO_PATH=/app/apps/api/dist/autoseo.js
URL_FILE=/root/wb-autoseo-webhook-url.txt
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/autoseo-tenant-${STAMP}"

mkdir -p "$WORK"
test "$(docker inspect "$C" --format '{{.State.Running}}')" = true
test "$(docker inspect "$C" --format '{{.Image}}')" = "$EXPECTED_IMAGE"
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4341/api/healthz)" = 200
test -s "$URL_FILE"
docker exec "$C" test -f "$AUTOSEO_PATH"
docker cp "$C:$AUTOSEO_PATH" "$WORK/autoseo.before.js"
cp -a "$WORK/autoseo.before.js" "$WORK/autoseo.patched.js"

docker run --rm --network none --user 0:0 -i \
  -v "$WORK:/work" --entrypoint node "$EXPECTED_IMAGE" --input-type=module <<'NODE'
import fs from "node:fs";

const file = "/work/autoseo.patched.js";
let source = fs.readFileSync(file, "utf8");
const marker = "WB_AUTOSEO_TENANT_CONTEXT_CANARY";

function once(oldValue, newValue, label) {
  const count = source.split(oldValue).length - 1;
  if (count !== 1) throw new Error(`${label}_not_unique:${count}`);
  source = source.replace(oldValue, newValue);
}

if (!source.includes(marker)) {
  once(
    `async function importImage(urlValue, privateRoot) {`,
    `async function importImage(urlValue, privateRoot, tenantId) {`,
    "import_image_signature"
  );
  once(
    `    const client = await pool.connect();
    let created = false, storageName, previousDeletedAt, target, previousReferenceCount = 0;`,
    `    const client = await pool.connect();
    await client.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]);
    let created = false, storageName, previousDeletedAt, target, previousReferenceCount = 0;`,
    "import_image_tenant_session"
  );
  once(
    `    finally {
        client.release();
    }
}
async function secret()`,
    `    finally {
        await client.query("RESET app.tenant_id").catch(() => undefined);
        client.release();
    }
}
async function secret()`,
    "import_image_tenant_reset"
  );
  once(
    `async function compensateImportedImages(images, privateRoot) {`,
    `async function compensateImportedImages(images, privateRoot, tenantId) {`,
    "compensate_signature"
  );
  once(
    `const referenced = await query("SELECT count(*)::int count FROM app.resource_files WHERE file_id=$1", [image.fileId]);`,
    `const referenced = await query("SELECT count(*)::int count FROM app.resource_files WHERE file_id=$1 AND tenant_id=$2", [image.fileId, tenantId]);`,
    "compensate_reference_tenant"
  );
  once(
    `await query("UPDATE files.objects SET deleted_at=$2 WHERE id=$1 AND deleted_at IS NULL", [image.fileId, image.previousDeletedAt]);`,
    `await query("UPDATE files.objects SET deleted_at=$2 WHERE id=$1 AND tenant_id=$3 AND deleted_at IS NULL", [image.fileId, image.previousDeletedAt, tenantId]);`,
    "compensate_update_tenant"
  );
  once(
    `await query("DELETE FROM files.objects WHERE id=$1", [image.fileId]);`,
    `await query("DELETE FROM files.objects WHERE id=$1 AND tenant_id=$2", [image.fileId, tenantId]);`,
    "compensate_delete_tenant"
  );
  once(
    `async function importArticleImages(inputs, privateRoot) {`,
    `async function importArticleImages(inputs, privateRoot, tenantId) {`,
    "import_images_signature"
  );
  once(
    `images[index] = await importImage(inputs[index].sourceUrl, privateRoot);`,
    `images[index] = await importImage(inputs[index].sourceUrl, privateRoot, tenantId);`,
    "import_image_call"
  );
  const compensationCalls = source.split(`await compensateImportedImages(images, privateRoot);`).length - 1;
  if (compensationCalls !== 2) throw new Error(`import_compensation_calls_not_two:${compensationCalls}`);
  source = source.replaceAll(`await compensateImportedImages(images, privateRoot);`, `await compensateImportedImages(images, privateRoot, tenantId);`);
  once(
    `async function publicationClient(images, privateRoot) {`,
    `async function publicationClient(images, privateRoot, tenantId) {`,
    "publication_client_signature"
  );

  once(
    `        if (eventType === "test")
            return { url: "https://www.wb-holding.ag/blog", status: "ok" };
        const payloadSha256 = digest(rawBody), articleValue = envelope.data.article || envelope.data.data || envelope.data.payload || envelope.data;`,
    `        if (eventType === "test")
            return { url: "https://www.wb-holding.ag/blog", status: "ok" };
        // WB_AUTOSEO_TENANT_CONTEXT_CANARY
        const tenantResult = await query("SELECT tenant_id FROM iam.users WHERE lower(email)=lower($1) AND tenant_id IS NOT NULL LIMIT 1", ["admin@wb-holding.ag"]);
        const tenantId = tenantResult.rows[0]?.tenant_id;
        if (!tenantId)
            return reply.code(503).send({ error: "tenant_context_unavailable", correlationId: req.id });
        const payloadSha256 = digest(rawBody), articleValue = envelope.data.article || envelope.data.data || envelope.data.payload || envelope.data;`,
    "request_tenant_resolution"
  );
  once(
    `inserted = await query(\`INSERT INTO integration.autoseo_deliveries(delivery_id,event_type,external_id,payload_sha256,status)
    VALUES($1,$2,$3,$4,'processing') ON CONFLICT(delivery_id) DO NOTHING RETURNING *\`, [delivery, eventType, externalId, payloadSha256]);`,
    `inserted = await query(\`INSERT INTO integration.autoseo_deliveries(delivery_id,event_type,external_id,payload_sha256,status,tenant_id)
    VALUES($1,$2,$3,$4,'processing',$5) ON CONFLICT(delivery_id) DO NOTHING RETURNING *\`, [delivery, eventType, externalId, payloadSha256, tenantId]);`,
    "delivery_insert_tenant"
  );
  once(
    `const current = await query("SELECT * FROM integration.autoseo_deliveries WHERE delivery_id=$1", [delivery]);`,
    `const current = await query("SELECT * FROM integration.autoseo_deliveries WHERE delivery_id=$1 AND tenant_id=$2", [delivery, tenantId]);`,
    "delivery_select_tenant"
  );
  once(
    `WHERE delivery_id=$1 AND status='failed' RETURNING delivery_id\`, [delivery]);`,
    `WHERE delivery_id=$1 AND tenant_id=$2 AND status='failed' RETURNING delivery_id\`, [delivery, tenantId]);`,
    "delivery_claim_tenant"
  );
  once(
    `await query("UPDATE integration.autoseo_deliveries SET status='failed',last_error_code='article_schema_invalid' WHERE delivery_id=$1", [delivery]);`,
    `await query("UPDATE integration.autoseo_deliveries SET status='failed',last_error_code='article_schema_invalid' WHERE delivery_id=$1 AND tenant_id=$2", [delivery, tenantId]);`,
    "delivery_schema_failure_tenant"
  );
  once(
    `await query("UPDATE integration.autoseo_deliveries SET status='failed',last_error_code=$1 WHERE delivery_id=$2", [text(error.message).slice(0, 120) || "faq_schema_invalid", delivery]);`,
    `await query("UPDATE integration.autoseo_deliveries SET status='failed',last_error_code=$1 WHERE delivery_id=$2 AND tenant_id=$3", [text(error.message).slice(0, 120) || "faq_schema_invalid", delivery, tenantId]);`,
    "delivery_faq_failure_tenant"
  );
  once(
    `await query("UPDATE integration.autoseo_deliveries SET status='failed',last_error_code='article_image_limit_exceeded' WHERE delivery_id=$1", [delivery]);`,
    `await query("UPDATE integration.autoseo_deliveries SET status='failed',last_error_code='article_image_limit_exceeded' WHERE delivery_id=$1 AND tenant_id=$2", [delivery, tenantId]);`,
    "delivery_image_limit_tenant"
  );
  once(
    `const importedImages = await importArticleImages(articleImages, ctx.privateRoot);`,
    `const importedImages = await importArticleImages(articleImages, ctx.privateRoot, tenantId);`,
    "import_images_tenant_call"
  );
  once(
    `const client = await publicationClient(importedImages, ctx.privateRoot);
            let resourceId = "";`,
    `const client = await publicationClient(importedImages, ctx.privateRoot, tenantId);
            await client.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]);
            let resourceId = "";`,
    "publication_tenant_session"
  );
  once(
    `await client.query("UPDATE integration.autoseo_deliveries SET status='published',resource_id=$1,published_url=$2,processed_at=now(),last_error_code=NULL WHERE delivery_id=$3", [resourceId, publishedUrl, delivery]);`,
    `await client.query("UPDATE integration.autoseo_deliveries SET status='published',resource_id=$1,published_url=$2,processed_at=now(),last_error_code=NULL WHERE delivery_id=$3 AND tenant_id=$4", [resourceId, publishedUrl, delivery, tenantId]);`,
    "delivery_publish_tenant"
  );
  once(
    `await compensateImportedImages(importedImages, ctx.privateRoot);`,
    `await compensateImportedImages(importedImages, ctx.privateRoot, tenantId);`,
    "publication_compensation_tenant"
  );
  once(
    `await query("INSERT INTO audit.events(action,object_type,object_id,changed_fields,request_id,metadata) VALUES('autoseo_publish_compensated','blogposts',$1,$2,$3,$4::jsonb)", [resourceId || null, ["publicCms", "media", "idempotency"], req.id, jsonb({ eventType, externalId: article.id, deliveryHash: digest(delivery), reason: text(error.message).slice(0, 120) })]);`,
    `await query("INSERT INTO audit.events(action,object_type,object_id,changed_fields,request_id,metadata,tenant_id) VALUES('autoseo_publish_compensated','blogposts',$1,$2,$3,$4::jsonb,$5)", [resourceId || null, ["publicCms", "media", "idempotency"], req.id, jsonb({ eventType, externalId: article.id, deliveryHash: digest(delivery), reason: text(error.message).slice(0, 120) }), tenantId]);`,
    "compensation_audit_tenant"
  );
  once(
    `            finally {
                client.release();
            }`,
    `            finally {
                await client.query("RESET app.tenant_id").catch(() => undefined);
                client.release();
            }`,
    "publication_tenant_reset"
  );
  once(
    `await query("UPDATE integration.autoseo_deliveries SET status='failed',last_error_code=$1 WHERE delivery_id=$2", [errorCode, delivery]).catch(() => undefined);`,
    `await query("UPDATE integration.autoseo_deliveries SET status='failed',last_error_code=$1 WHERE delivery_id=$2 AND tenant_id=$3", [errorCode, delivery, tenantId]).catch(() => undefined);`,
    "delivery_final_failure_tenant"
  );
}

fs.writeFileSync(file, source);
NODE

grep -Fq 'WB_AUTOSEO_TENANT_CONTEXT_CANARY' "$WORK/autoseo.patched.js"
docker run --rm --network none --user 0:0 \
  -v "$WORK:/work:ro" --entrypoint node "$EXPECTED_IMAGE" --check /work/autoseo.patched.js

PATCHED=false
rollback() {
  STATUS=$?
  if test "$PATCHED" = true; then
    docker cp "$WORK/autoseo.before.js" "$C:$AUTOSEO_PATH" >/dev/null
    docker restart "$C" >/dev/null
    printf '%s\n' 'WB_AUTOSEO_TENANT_ROLLBACK=SUCCESS'
  fi
  exit "$STATUS"
}
trap rollback ERR

docker cp "$WORK/autoseo.patched.js" "$C:$AUTOSEO_PATH"
PATCHED=true
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
UNAUTHORIZED=$(curl -ksS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' --data '{"event":"test"}' https://www.enwi.online/api/integrations/autoseo/webhook)
AUTHORIZED=$(curl -ksS -o "$WORK/autoseo-test.json" -w '%{http_code}' -H 'content-type: application/json' --data '{"event":"test"}' "$WEBHOOK_URL")
test "$UNAUTHORIZED" = 401
test "$AUTHORIZED" = 200
grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' "$WORK/autoseo-test.json"

PATCHED=false
trap - ERR
printf '%s\n' 'WB_AUTOSEO_TENANT_CANARY=SUCCESS'
printf 'backup_directory=%s\n' "$WORK"
printf '%s\n' 'article_sent=false'
printf '%s\n' 'production_database_changed=false'
printf '%s\n' 'production_mfa_changed=false'
printf '%s\n' 'external_submission_changed=false'
