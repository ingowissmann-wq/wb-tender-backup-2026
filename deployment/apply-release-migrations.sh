#!/usr/bin/env bash
set -Eeuo pipefail
: "${RELEASE_ID:?RELEASE_ID is required}"
if [[ "${REHEARSAL_DATABASE_TRUSTED:-false}" == true ]]; then
  database=(-h db -U postgres -d wb_rehearsal)
else
  : "${DATABASE_URL_FILE:?DATABASE_URL_FILE is required}"
  [[ -r "$DATABASE_URL_FILE" ]] || { echo "database secret file is unreadable" >&2; exit 66; }
  database=("$(cat "$DATABASE_URL_FILE")")
fi
psql "${database[@]}" -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS tender;
CREATE TABLE IF NOT EXISTS tender.release_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS tender.release_plan_snapshots(release_id text PRIMARY KEY, rows jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
SQL
for migration in migrations/155_autopilot_overview_latest_lookup.sql migrations/156_approved_tender_commercial_plans.sql migrations/157_release_auth_and_commercial_enforcement.sql migrations/158_tender_login_challenge_runtime_grants.sql; do
  name=${migration##*/}; checksum=$(sha256sum "$migration" | cut -d' ' -f1)
  known=$(psql "${database[@]}" -Atv ON_ERROR_STOP=1 -v name="$name" <<'SQL'
SELECT checksum FROM tender.release_migrations WHERE name=:'name';
SQL
)
  [[ -z "$known" || "$known" == "$checksum" ]] || { echo "migration checksum mismatch: $name" >&2; exit 65; }
  if [[ -z "$known" ]]; then
    if [[ "$name" == 156_approved_tender_commercial_plans.sql ]]; then
      psql "${database[@]}" -v ON_ERROR_STOP=1 -v release_id="$RELEASE_ID" <<'SQL'
INSERT INTO tender.release_plan_snapshots(release_id,rows)
SELECT :'release_id',jsonb_agg(to_jsonb(p) ORDER BY code)
FROM saas.plans p
WHERE code IN ('CORE','NORMAL','PROFESSIONAL','ENTERPRISE');
SQL
    fi
    printf 'ROLLBACK_MIGRATION=%s\n' "$name"
    psql "${database[@]}" -v ON_ERROR_STOP=1 -f "$migration"
    psql "${database[@]}" -v ON_ERROR_STOP=1 -v name="$name" -v checksum="$checksum" <<'SQL'
INSERT INTO tender.release_migrations(name,checksum) VALUES (:'name',:'checksum');
SQL
    printf 'APPLIED_MIGRATION=%s\n' "$name"
  else
    printf 'SKIPPED_MIGRATION=%s\n' "$name"
  fi
done
