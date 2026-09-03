#!/usr/bin/env bash
set -Eeuo pipefail
: "${DATABASE_URL_FILE:?DATABASE_URL_FILE is required}"
: "${RELEASE_ID:?RELEASE_ID is required}"
[[ -r "$DATABASE_URL_FILE" ]] || { echo "database secret file is unreadable" >&2; exit 66; }
url=$(cat "$DATABASE_URL_FILE")
psql "$url" -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS tender;
CREATE TABLE IF NOT EXISTS tender.release_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS tender.release_plan_snapshots(release_id text PRIMARY KEY, rows jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
SQL
psql "$url" -v ON_ERROR_STOP=1 -v release_id="$RELEASE_ID" -c "INSERT INTO tender.release_plan_snapshots(release_id,rows) SELECT :'release_id',jsonb_agg(to_jsonb(p) ORDER BY code) FROM saas.plans p WHERE code IN ('CORE','NORMAL','PROFESSIONAL','ENTERPRISE') ON CONFLICT (release_id) DO NOTHING"
for migration in migrations/155_autopilot_overview_latest_lookup.sql migrations/156_approved_tender_commercial_plans.sql; do
  name=${migration##*/}; checksum=$(sha256sum "$migration" | cut -d' ' -f1)
  known=$(psql "$url" -Atv ON_ERROR_STOP=1 -v name="$name" -c "SELECT checksum FROM tender.release_migrations WHERE name=:'name'")
  [[ -z "$known" || "$known" == "$checksum" ]] || { echo "migration checksum mismatch: $name" >&2; exit 65; }
  if [[ -z "$known" ]]; then
    psql "$url" -v ON_ERROR_STOP=1 -f "$migration"
    psql "$url" -v ON_ERROR_STOP=1 -v name="$name" -v checksum="$checksum" -c "INSERT INTO tender.release_migrations(name,checksum) VALUES (:'name',:'checksum')"
  fi
done
