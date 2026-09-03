#!/usr/bin/env bash
set -Eeuo pipefail

C=wb-admin-rehearsal-auth-1
EXPECTED_IMAGE='sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86'
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/public-media-autoseo-${STAMP}"
AUTOSEO_PATH=/app/apps/api/dist/api/autoseo.js
URL_FILE=/root/wb-autoseo-webhook-url.txt
TMP_CFG=$(mktemp)
TMP_ENWI=$(mktemp)

mkdir -p "$WORK"
trap 'rm -f "$TMP_CFG" "$TMP_ENWI"' EXIT

ACTUAL_RUNNING=$(docker inspect "$C" --format '{{.State.Running}}')
ACTUAL_IMAGE=$(docker inspect "$C" --format '{{.Image}}')
HEALTH_CODE=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4341/api/healthz || true)
if test "$ACTUAL_RUNNING" != true || test "$ACTUAL_IMAGE" != "$EXPECTED_IMAGE" || test "$HEALTH_CODE" != 200; then
  printf 'preflight_blocked=canary_identity_or_health running=%s image=%s health=%s\n' "$ACTUAL_RUNNING" "$ACTUAL_IMAGE" "$HEALTH_CODE" >&2
  exit 41
fi
printf '%s\n' 'preflight=canary_identity_and_health_ok'

ENWI_CFG=$(readlink -f /etc/nginx/sites-enabled/wb-tender-www.conf)
test -f "$ENWI_CFG"
MEDIA_INCLUDE=$(awk '/^[[:space:]]*include \/etc\/nginx\/snippets\/wb-admin-canary-media-.*[.]conf;[[:space:]]*$/ {print $2}' "$ENWI_CFG" | tr -d ';' | tail -n 1)
test -n "$MEDIA_INCLUDE"
test -f "$MEDIA_INCLUDE"
MEDIA_ID=$(awk '$1 == "location" && $2 == "=" && $3 ~ /^\/cms-media\/[0-9a-f-]+$/ {sub("^/cms-media/", "", $3); print $3; exit}' "$MEDIA_INCLUDE")
test -n "$MEDIA_ID"
printf '%s\n' 'preflight=existing_canary_media_include_ok'

mapfile -t CANDIDATES < <(
  nginx -T 2>&1 |
    awk '
      /^# configuration file \/.*:$/ {
        file=$0
        sub(/^# configuration file /, "", file)
        sub(/:$/, "", file)
        next
      }
      /server_name[^;]*www[.]wb-holding[.]ag/ && file != "" { print file }
    ' |
    while read -r f; do test -f "$f" && readlink -f "$f"; done |
    sort -u
)
test "${#CANDIDATES[@]}" -ge 1
printf 'preflight=active_public_vhost_candidates_ok count=%s\n' "${#CANDIDATES[@]}"

PUBLIC_CFG=$(
  python3 - "$MEDIA_INCLUDE" "${CANDIDATES[@]}" <<'PY'
import pathlib, re, sys

include_path = sys.argv[1]
matches = []
for raw_path in sys.argv[2:]:
    path = pathlib.Path(raw_path)
    text = path.read_text()
    lines = text.splitlines(keepends=True)
    depth = 0
    start = None
    for index, line in enumerate(lines):
        clean = re.sub(r'#.*$', '', line)
        if start is None and re.search(r'\bserver\s*\{', clean):
            start = index
            block_depth = depth
        depth += clean.count('{') - clean.count('}')
        if start is not None and depth == block_depth:
            block = ''.join(lines[start:index + 1])
            if (re.search(r'\blisten\s+[^;]*443\b', block)
                    and re.search(r'\bserver_name\s+[^;]*(?:^|\s)www\.wb-holding\.ag(?:\s|;)', block, re.M)):
                matches.append((str(path), start, index))
            start = None

if len(matches) != 1:
    raise SystemExit(f"expected_one_wb_holding_tls_server_found_{len(matches)}")

print(matches[0][0])
PY
)

test -f "$PUBLIC_CFG"
printf 'preflight=public_tls_vhost_ok file=%s\n' "$PUBLIC_CFG"
PUBLIC_BACKUP="$WORK/$(basename "$PUBLIC_CFG").before"
cp -a "$PUBLIC_CFG" "$PUBLIC_BACKUP"
ENWI_BACKUP="$WORK/$(basename "$ENWI_CFG").before"
cp -a "$ENWI_CFG" "$ENWI_BACKUP"

python3 - "$PUBLIC_CFG" "$MEDIA_INCLUDE" "$TMP_CFG" <<'PY'
import pathlib, re, sys

source, include_path, target = map(pathlib.Path, sys.argv[1:])
text = source.read_text()
if str(include_path) in text:
    pathlib.Path(target).write_text(text)
    raise SystemExit(0)

lines = text.splitlines(keepends=True)
depth = 0
start = None
matches = []
for index, line in enumerate(lines):
    clean = re.sub(r'#.*$', '', line)
    if start is None and re.search(r'\bserver\s*\{', clean):
        start = index
        block_depth = depth
    depth += clean.count('{') - clean.count('}')
    if start is not None and depth == block_depth:
        block = ''.join(lines[start:index + 1])
        if (re.search(r'\blisten\s+[^;]*443\b', block)
                and re.search(r'\bserver_name\s+[^;]*(?:^|\s)www\.wb-holding\.ag(?:\s|;)', block, re.M)):
            matches.append((start, index))
        start = None

if len(matches) != 1:
    raise SystemExit(f"expected_one_wb_holding_tls_server_found_{len(matches)}")

_, end = matches[0]
indent = re.match(r'\s*', lines[end]).group(0) + '    '
lines.insert(end, f'{indent}include {include_path};\n')
pathlib.Path(target).write_text(''.join(lines))
PY

python3 - "$ENWI_CFG" "$TMP_ENWI" <<'PY'
import pathlib, re, sys

source, target = map(pathlib.Path, sys.argv[1:])
text = source.read_text()
pattern = re.compile(r'(\n(?P<i>\s*)location\s*=\s*/api/integrations/autoseo/webhook\s*\{)(?P<body>.*?)(\n(?P=i)\})', re.S)
matches = list(pattern.finditer(text))
if len(matches) != 1:
    raise SystemExit(f"expected_one_autoseo_location_found_{len(matches)}")
match = matches[0]
if re.search(r'^\s*access_log\s+off\s*;', match.group('body'), re.M):
    pathlib.Path(target).write_text(text)
else:
    indent = match.group('i') + '    '
    patched = text[:match.end(1)] + f'\n{indent}access_log off;' + text[match.end(1):]
    pathlib.Path(target).write_text(patched)
PY

docker cp "$C:$AUTOSEO_PATH" "$WORK/autoseo.before.js"
cp -a "$WORK/autoseo.before.js" "$WORK/autoseo.patched.js"

docker run --rm --network none --user 0:0 -i \
  -v "$WORK:/work" --entrypoint node "$EXPECTED_IMAGE" --input-type=module <<'NODE'
import fs from "node:fs";

const path = "/work/autoseo.patched.js";
let source = fs.readFileSync(path, "utf8");
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
const newAuth = `        const rawBody = req.rawBody, authorization = text(req.headers.authorization), signatureHeader = text(req.headers["x-autoseo-signature"]);
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
fs.writeFileSync(path, source);
NODE

docker run --rm --network none --user 0:0 -v "$WORK:/work:ro" --entrypoint node "$EXPECTED_IMAGE" --check /work/autoseo.patched.js

PATCHED_CFG=false
PATCHED_ENWI=false
PATCHED_APP=false
rollback() {
  STATUS=$?
  if test "$PATCHED_CFG" = true; then cp -a "$PUBLIC_BACKUP" "$PUBLIC_CFG"; fi
  if test "$PATCHED_ENWI" = true; then cp -a "$ENWI_BACKUP" "$ENWI_CFG"; fi
  if test "$PATCHED_APP" = true; then docker cp "$WORK/autoseo.before.js" "$C:$AUTOSEO_PATH" >/dev/null; docker restart "$C" >/dev/null; fi
  if nginx -t >/dev/null 2>&1; then systemctl reload nginx; fi
  printf '%s\n' 'WB_PUBLIC_MEDIA_AUTOSEO_ROLLBACK=SUCCESS'
  exit "$STATUS"
}
trap rollback ERR

cat "$TMP_CFG" > "$PUBLIC_CFG"
PATCHED_CFG=true
cat "$TMP_ENWI" > "$ENWI_CFG"
PATCHED_ENWI=true
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

test "$(curl -ksS -o /dev/null -w '%{http_code}' "https://www.wb-holding.ag/cms-media/${MEDIA_ID}")" = 200
test "$(curl -ksS -o /dev/null -w '%{http_code}' "https://www.enwi.online/cms-media/${MEDIA_ID}")" = 200

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
PATCHED_ENWI=false
PATCHED_APP=false
trap - ERR
rm -f "$TMP_CFG" "$TMP_ENWI"

printf '%s\n' 'WB_PUBLIC_CMS_MEDIA_ROUTE=SUCCESS'
printf '%s\n' 'WB_AUTOSEO_URL_AUTH_CANARY=SUCCESS'
printf 'webhook_url_file=%s\n' "$URL_FILE"
printf 'backup_directory=%s\n' "$WORK"
printf '%s\n' 'article_sent=false'
printf '%s\n' 'production_database_changed=false'
printf '%s\n' 'production_mfa_changed=false'
printf '%s\n' 'external_submission_changed=false'
