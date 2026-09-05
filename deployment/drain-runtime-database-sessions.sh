#!/usr/bin/env bash
set -Eeuo pipefail
: "${DATABASE_URL_FILE:?DATABASE_URL_FILE is required}"
[[ -r "$DATABASE_URL_FILE" ]] || { echo "database URL file is unreadable" >&2; exit 66; }
runtime_role=${RUNTIME_DATABASE_ROLE:-wb_tender_api_login}
[[ "$runtime_role" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "runtime database role is invalid" >&2; exit 64; }
url=$(cat "$DATABASE_URL_FILE")
terminated=$(psql "$url" -Atv ON_ERROR_STOP=1 -v runtime_role="$runtime_role" <<'SQL'
SELECT count(*)
FROM (
  SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE datname=current_database()
    AND usename=:'runtime_role'
    AND backend_type='client backend'
    AND pid<>pg_backend_pid()
) drained;
SQL
)
for attempt in {1..30}; do
  remaining=$(psql "$url" -Atv ON_ERROR_STOP=1 -v runtime_role="$runtime_role" <<'SQL'
SELECT count(*)
FROM pg_stat_activity
WHERE datname=current_database()
  AND usename=:'runtime_role'
  AND backend_type='client backend'
  AND pid<>pg_backend_pid();
SQL
)
  if [[ "$remaining" == 0 ]]; then
    printf 'RUNTIME_SESSIONS_TERMINATED=%s\nRUNTIME_SESSIONS_REMAINING=0\n' "$terminated"
    exit 0
  fi
  sleep 1
done
echo "runtime database sessions did not drain" >&2
exit 75
