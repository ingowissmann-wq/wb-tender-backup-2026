#!/usr/bin/env bash
set -Eeuo pipefail

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/tender-reset-mail-diagnosis-${STAMP}"
mkdir -p "$WORK"

API=wb-tender-production-api
if ! docker inspect "$API" >/dev/null 2>&1; then
  API=$(docker ps --format '{{.Names}}' | awk '/production/ && /api/ {print; exit}')
fi
if test -z "${API:-}" || ! docker inspect "$API" >/dev/null 2>&1; then
  printf '%s\n' 'diagnosis=production_api_not_found'
  printf '%s\n' 'WB_TENDER_RESET_MAIL_READONLY=INCOMPLETE'
  exit 0
fi

printf '%s\n' '===== LIVE-API ====='
printf 'container=%s\n' "$API"
docker inspect "$API" --format 'image={{.Config.Image}} status={{.State.Status}} readonly_rootfs={{.HostConfig.ReadonlyRootfs}}'

docker inspect "$API" --format '{{range .Config.Env}}{{println .}}{{end}}' |
  sed 's/=.*//' |
  grep -Ei '(^|_)(SMTP|MAIL|EMAIL|RESET|OWNER)(_|$)' |
  sort -u >"$WORK/mail-env-keys.txt" || true

printf '%s\n' '===== MAIL-KONFIGURATION (NUR VARIABLENNAMEN) ====='
if test -s "$WORK/mail-env-keys.txt"; then
  sed 's/$/=present/' "$WORK/mail-env-keys.txt"
else
  printf '%s\n' 'none'
fi

printf '%s\n' '===== RESET-RUNTIME ====='
docker exec "$API" node --input-type=module -e '
  import fs from "node:fs";
  const candidates=[
    "/app/platform/owner-auth.mjs",
    "/app/apps/api/dist/server.js",
    "/app/apps/api/dist/iam.js"
  ];
  for(const file of candidates){
    if(!fs.existsSync(file)) continue;
    const source=fs.readFileSync(file,"utf8");
    const env=[...source.matchAll(/process[.]env[.]([A-Z0-9_]+)/g)].map(match=>match[1]);
    console.log("file="+file);
    console.log("has_forgot_route="+/password[/]forgot|forgot-password|password-reset/i.test(source));
    console.log("has_mail_sender="+/nodemailer|smtp|sendmail|sendMail|sendPasswordReset/i.test(source));
    console.log("referenced_mail_env="+[...new Set(env.filter(name=>/(SMTP|MAIL|EMAIL|RESET|OWNER)/.test(name)))].sort().join(","));
  }
' || printf '%s\n' 'runtime_inspection=unavailable'

DB=wb-tender-production-db
if ! docker inspect "$DB" >/dev/null 2>&1; then
  DB=$(docker ps --format '{{.Names}}' | awk '/production/ && /(db|postgres)/ {print; exit}')
fi

printf '%s\n' '===== BENUTZER UND RESET-TABELLEN ====='
if test -n "${DB:-}" && docker inspect "$DB" >/dev/null 2>&1; then
  printf 'database_container=%s\n' "$DB"
  docker exec "$DB" sh -lc '
    psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'"'"'SQL'"'"'
BEGIN READ ONLY;
SELECT to_regclass('"'"'iam.users'"'"') AS iam_users;
SELECT count(*) AS matching_users,
       count(*) FILTER (WHERE active IS TRUE) AS active_users
FROM iam.users
WHERE lower(email)=lower('"'"'admin@wb-holding.ag'"'"');
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_name ILIKE '"'"'%reset%'
   OR table_name ILIKE '"'"'%password%token%'
ORDER BY table_schema, table_name;
COMMIT;
SQL
  ' || printf '%s\n' 'database_read=failed'
else
  printf '%s\n' 'database_container=not_found'
fi

printf '%s\n' '===== LETZTE RESET-/MAIL-EREIGNISSE ====='
docker logs --since 60m "$API" 2>&1 |
  grep -Ei 'password.?reset|password.?forgot|smtp|mail|email|ECONN|ETIMEDOUT|ENOTFOUND|auth' |
  tail -n 120 |
  sed -E 's/([?&](token|key)=)[^&" ]+/\1[REDACTED]/Ig; s/[A-Fa-f0-9]{48,}/[REDACTED]/g' || true

printf '%s\n' 'WB_TENDER_RESET_MAIL_READONLY=SUCCESS'
printf '%s\n' 'changed=false'
printf '%s\n' 'secret_values_printed=false'
printf 'report_directory=%s\n' "$WORK"
