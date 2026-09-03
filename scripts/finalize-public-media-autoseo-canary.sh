#!/usr/bin/env bash
set -Eeuo pipefail

C=wb-admin-rehearsal-auth-1
EXPECTED_IMAGE='sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86'
CFG=$(readlink -f /etc/nginx/sites-enabled/wb-tender-www.conf)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/public-api-autoseo-${STAMP}"
AUTOSEO_PATH=/app/apps/api/dist/api/autoseo.js
URL_FILE=/root/wb-autoseo-webhook-url.txt
TMP_CFG=$(mktemp)

mkdir -p "$WORK"
trap 'rm -f "$TMP_CFG"' EXIT

ACTUAL_RUNNING=$(docker inspect "$C" --format '{{.State.Running}}')
ACTUAL_IMAGE=$(docker inspect "$C" --format '{{.Image}}')
HEALTH_CODE=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4341/api/healthz || true)
if test "$ACTUAL_RUNNING" != true || test "$ACTUAL_IMAGE" != "$EXPECTED_IMAGE" || test "$HEALTH_CODE" != 200; then
  printf 'preflight_blocked=canary_identity_or_health running=%s image=%s health=%s\n' "$ACTUAL_RUNNING" "$ACTUAL_IMAGE" "$HEALTH_CODE" >&2
  exit 41
fi
printf '%s\n' 'preflight=canary_identity_and_health_ok'

test -f "$CFG"
test "$(grep -Fxc '    location ^~ /api/admin/ {' "$CFG")" -eq 1
test "$(grep -Fxc '    location = /api/integrations/autoseo/webhook {' "$CFG")" -eq 1
cp -a "$CFG" "$WORK/wb-tender-www.conf.before"

python3 - "$CFG" "$TMP_CFG" <<'PY'
import pathlib, re, sys

source, target = map(pathlib.Path, sys.argv[1:])
text = source.read_text()

autoseo = re.compile(r'(\n(?P<i>\s*)location\s*=\s*/api/integrations/autoseo/webhook\s*\{)(?P<body>.*?)(\n(?P=i)\})', re.S)
matches = list(autoseo.finditer(text))
if len(matches) != 1:
    raise SystemExit(f"expected_one_autoseo_location_found_{len(matches)}")
match = matches[0]
if not re.search(r'^\s*access_log\s+off\s*;', match.group('body'), re.M):
    indent = match.group('i') + '    '
    text = text[:match.end(1)] + f'\n{indent}access_log off;' + text[match.end(1):]

public_line = '    location ^~ /api/public/ {'
if public_line not in text:
    admin_line = '    location ^~ /api/admin/ {'
    if text.count(admin_line) != 1:
        raise SystemExit(f"expected_one_admin_api_location_found_{text.count(admin_line)}")
    public_block = '''    location ^~ /api/public/ {
        proxy_pass http://127.0.0.1:4341;
        include /etc/nginx/proxy_params;
        proxy_http_version 1.1;
        proxy_read_timeout 60s;
    }

'''
    text = text.replace(admin_line, public_block + admin_line)

pathlib.Path(target).write_text(text)
PY

docker cp "$C:$AUTOSEO_PATH" "$WORK/autoseo.before.js"
cp -a "$WORK/autoseo.before.js" "$WORK/autoseo.patched.js"

docker run --rm --network none --user 0:0 -i \
  -v "$WORK:/work" --entrypoint node "$EXPECTED_IMAGE" --input-type=module <<'NODE'
import fs from "node:fs";

const path = "/work/autoseo.patched.js";
let source = fs.readFileSync(path, "utf8");
const marker = "WB_AUTOSEO_URL_AUTH_CANARY";
if (!source.includes(marker)) {
  const oldAuth = `        const rawBody = req.rawBody, authorization = text(req.headers.authorization), delivery = text(req.headers["x-autoseo-delivery"]), signatureHeader = text(req.headers["x-autoseo-signature"]);
        const credentials = await secret(), bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        const match = signaturePattern.exec(signatureHeader);
        if (!bearer || !match)
            return reply.code(401).send({ error: "unauthorized", correlationId: req.id });
        if (!rawBody)
            return reply.code(400).send({ error: "invalid_request", correlationId: req.id });
        const expected = crypto.createHmac("sha256", credentials.token).update(rawBody).digest("hex");
        if (!constantEqual(bearer, credentials.token) || !constantEqual(match[1].toLowerCase(), expected))
            return reply.code(401).send({ error: "unauthorized", correlationId: req.id });
        if (!deliveryPattern.test(delivery))
            return reply.code(400).send({ error: "invalid_request", correlationId: req.id });`;
  const newAuth = `        // WB_AUTOSEO_URL_AUTH_CANARY
        const rawBody = req.rawBody, authorization = text(req.headers.authorization), signatureHeader = text(req.headers["x-autoseo-signature"]);
        let delivery = text(req.headers["x-autoseo-delivery"]);
        const credentials = await secret(), bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        const match = signaturePattern.exec(signatureHeader);
        if (!rawBody)
            return reply.code(400).send({ error: "invalid_request", correlationId: req.id });
        const expected = crypto.createHmac("sha256", credentials.token).update(rawBody).digest("hex");
        const signedRequest = Boolean(bearer && match && constantEqual(bearer, credentials.token) && constantEqual(match[1].toLowerCase(), expected));
        const endpointKey = crypto.createHmac("sha256", credentials.token).update("autoseo-endpoint-v1").digest("hex");
        const urlRequest = constantEqual(text(req.query?.key), endpointKey);
        if (!signedRequest && !urlRequest)
            return reply.code(401).send({ error: "unauthorized", correlationId: req.id });
        if (!delivery && urlRequest)
            delivery = \`autoseo-url-\${digest(rawBody)}\`;
        if (!deliveryPattern.test(delivery))
            return reply.code(400).send({ error: "invalid_request", correlationId: req.id });`;
  if ((source.split(oldAuth).length - 1) !== 1) throw new Error("autoseo_auth_patch_point_not_unique");
  source = source.replace(oldAuth, newAuth);

  const oldEvent = `        const eventType = headerEvent || bodyEvent;
        if (!["article.published", "article.updated", "test"].includes(eventType || ""))`;
  const newEvent = `        const articleCandidate = envelope.data.article || envelope.data.data || envelope.data.payload || envelope.data;
        const eventType = headerEvent || bodyEvent || (text(articleCandidate.id) && text(articleCandidate.title) ? "article.published" : undefined);
        if (!["article.published", "article.updated", "test"].includes(eventType || ""))`;
  if ((source.split(oldEvent).length - 1) !== 1) throw new Error("autoseo_event_patch_point_not_unique");
  source = source.replace(oldEvent, newEvent);
}
fs.writeFileSync(path, source);
NODE

docker run --rm --network none --user 0:0 -v "$WORK:/work:ro" --entrypoint node "$EXPECTED_IMAGE" --check /work/autoseo.patched.js
printf '%s\n' 'preflight=nginx_and_autoseo_patch_valid'

PATCHED_CFG=false
PATCHED_APP=false
rollback() {
  STATUS=$?
  if test "$PATCHED_CFG" = true; then cp -a "$WORK/wb-tender-www.conf.before" "$CFG"; fi
  if test "$PATCHED_APP" = true; then docker cp "$WORK/autoseo.before.js" "$C:$AUTOSEO_PATH" >/dev/null; docker restart "$C" >/dev/null; fi
  if nginx -t >/dev/null 2>&1; then systemctl reload nginx; fi
  printf '%s\n' 'WB_PUBLIC_API_AUTOSEO_ROLLBACK=SUCCESS'
  exit "$STATUS"
}
trap rollback ERR

cat "$TMP_CFG" > "$CFG"
PATCHED_CFG=true
nginx -t
systemctl reload nginx

docker cp "$WORK/autoseo.patched.js" "$C:$AUTOSEO_PATH"
PATCHED_APP=true
docker restart "$C" >/dev/null

HEALTH=false
for ATTEMPT in $(seq 1 30); do
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4341/api/healthz || true)
  if test "$CODE" = 200; then HEALTH=true; break; fi
  sleep 1
done
test "$HEALTH" = true

for TYPE in services blogposts jobs team; do
  CODE=$(curl -ksS -o "$WORK/public-${TYPE}.json" -w '%{http_code}' "https://www.enwi.online/api/public/v1/${TYPE}")
  test "$CODE" = 200
  grep -Eq '"items"[[:space:]]*:' "$WORK/public-${TYPE}.json"
done

TOKEN=$(docker exec "$C" node --input-type=module -e 'import fs from "node:fs"; const p=process.env.AUTOSEO_SECRET_FILE||"/run/secrets/autoseo_webhook"; const s=JSON.parse(fs.readFileSync(p,"utf8")); process.stdout.write(s.token);')
test "${#TOKEN}" -ge 32
KEY=$(printf '%s' 'autoseo-endpoint-v1' | openssl dgst -sha256 -hmac "$TOKEN" -hex | awk '{print $NF}')
test "${#KEY}" -eq 64
printf 'https://www.enwi.online/api/integrations/autoseo/webhook?key=%s\n' "$KEY" > "$URL_FILE"
chmod 0600 "$URL_FILE"

UNAUTHORIZED=$(curl -ksS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' --data '{"event":"test"}' https://www.enwi.online/api/integrations/autoseo/webhook)
test "$UNAUTHORIZED" = 401
AUTHORIZED=$(curl -ksS -o "$WORK/autoseo-test.json" -w '%{http_code}' -H 'content-type: application/json' --data '{"event":"test"}' "https://www.enwi.online/api/integrations/autoseo/webhook?key=${KEY}")
test "$AUTHORIZED" = 200
grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' "$WORK/autoseo-test.json"

PATCHED_CFG=false
PATCHED_APP=false
trap - ERR
rm -f "$TMP_CFG"

printf '%s\n' 'WB_PUBLIC_CANARY_API_ROUTE=SUCCESS'
printf '%s\n' 'WB_AUTOSEO_URL_AUTH_CANARY=SUCCESS'
printf 'webhook_url_file=%s\n' "$URL_FILE"
printf 'backup_directory=%s\n' "$WORK"
printf '%s\n' 'article_sent=false'
printf '%s\n' 'production_database_changed=false'
printf '%s\n' 'production_mfa_changed=false'
printf '%s\n' 'external_submission_changed=false'
