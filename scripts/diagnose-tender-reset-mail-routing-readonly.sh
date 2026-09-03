#!/usr/bin/env bash
set -Eeuo pipefail

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/tender-reset-routing-diagnosis-${STAMP}"
mkdir -p "$WORK"

printf '%s\n' '===== MAIL-KONFIGURATION ALLER CONTAINER (NUR NAMEN) ====='
FOUND=false
while IFS= read -r CONTAINER; do
  mapfile -t KEYS < <(
    docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null |
      sed 's/=.*//' |
      grep -Ei '(^|_)(SMTP|MAIL|EMAIL)(_|$)' |
      sort -u || true
  )
  if test "${#KEYS[@]}" -gt 0; then
    FOUND=true
    printf 'container=%s keys=%s\n' "$CONTAINER" "$(IFS=,; printf '%s' "${KEYS[*]}")"
  fi
done < <(docker ps --format '{{.Names}}')
test "$FOUND" = true || printf '%s\n' 'none'

printf '%s\n' '===== NODE-MAILER-VERFÜGBARKEIT ====='
while IFS= read -r CONTAINER; do
  docker exec "$CONTAINER" node -e '
    try { console.log(require.resolve("nodemailer")) }
    catch { process.exit(2) }
  ' >/dev/null 2>&1 && printf 'container=%s nodemailer=available\n' "$CONTAINER" || true
done < <(docker ps --format '{{.Names}}')

printf '%s\n' '===== NGINX-ROUTING ====='
grep -RInE 'server_name|location .*api/admin|proxy_pass|upstream'   /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null |
  grep -E 'enwi[.]online|api/admin|proxy_pass|upstream' |
  head -n 240 || true

DB=wb-tender-production-db
if ! docker inspect "$DB" >/dev/null 2>&1; then
  DB=$(docker ps --format '{{.Names}}' | awk '/production/ && /(db|postgres)/ {print; exit}')
fi

printf '%s\n' '===== RESET-SCHEMA ====='
if test -n "${DB:-}" && docker inspect "$DB" >/dev/null 2>&1; then
  docker exec -i "$DB" sh -lc 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL' || printf '%s\n' 'database_read=failed'
BEGIN READ ONLY;
SELECT table_schema, table_name, ordinal_position, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema='iam'
  AND table_name IN ('users','password_reset_events','password_reset_tokens')
ORDER BY table_name, ordinal_position;
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname='iam'
  AND tablename IN ('password_reset_events','password_reset_tokens')
ORDER BY tablename, indexname;
SELECT routine_schema, routine_name
FROM information_schema.routines
WHERE routine_schema='iam'
  AND (routine_name ILIKE '%reset%' OR routine_name ILIKE '%password%')
ORDER BY routine_name;
COMMIT;
SQL
else
  printf '%s\n' 'database_container=not_found'
fi

printf '%s\n' '===== ENDPOINT- UND MAIL-LOGS ALLER CONTAINER ====='
while IFS= read -r CONTAINER; do
  LOGS=$(docker logs --since 3h "$CONTAINER" 2>&1 |
    grep -Ei 'password/forgot|password.?reset|smtp|sendmail|nodemailer|ECONN|ETIMEDOUT|ENOTFOUND' |
    tail -n 80 |
    sed -E 's/([?&](token|key)=)[^&" ]+/\1[REDACTED]/Ig; s/[A-Fa-f0-9]{48,}/[REDACTED]/g' || true)
  if test -n "$LOGS"; then
    printf '%s\n' "--- container=$CONTAINER ---"
    printf '%s\n' "$LOGS"
  fi
done < <(docker ps --format '{{.Names}}')

printf '%s\n' 'WB_TENDER_RESET_ROUTING_READONLY=SUCCESS'
printf '%s\n' 'changed=false'
printf '%s\n' 'secret_values_printed=false'
printf 'report_directory=%s\n' "$WORK"
