#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
: "${DATABASE_URL_FILE:?DATABASE_URL_FILE is required}"
: "${STATE_OUTPUT_DIR:?STATE_OUTPUT_DIR is required}"
[[ -r "$DATABASE_URL_FILE" && -d "$STATE_OUTPUT_DIR" ]] || { echo "state capture inputs unavailable" >&2; exit 66; }
url=$(cat "$DATABASE_URL_FILE")
pg_dump "$url" --schema-only --no-owner --no-acl | sed '/^\\restrict /d;/^\\unrestrict /d' | sha256sum | cut -d' ' -f1 >"$STATE_OUTPUT_DIR/schema.sha256"
psql "$url" -Atv ON_ERROR_STOP=1 -c "SELECT encode(digest(coalesce(jsonb_agg(to_jsonb(p) ORDER BY code)::text,''),'sha256'),'hex') FROM saas.plans p WHERE code IN ('CORE','NORMAL','PROFESSIONAL','ENTERPRISE')" >"$STATE_OUTPUT_DIR/plans.sha256"
capture_optional_table() {
  table=$1 order=$2 label=$3
  present=$(psql "$url" -Atv ON_ERROR_STOP=1 -c "SELECT to_regclass('$table') IS NOT NULL")
  printf '%s\n' "$present" >"$STATE_OUTPUT_DIR/$label.present"
  if [[ "$present" == t ]]; then
    psql "$url" -Atv ON_ERROR_STOP=1 -c "COPY (SELECT to_jsonb(x)::text FROM $table x ORDER BY $order) TO STDOUT" | sha256sum | cut -d' ' -f1 >"$STATE_OUTPUT_DIR/$label.sha256"
  else
    printf 'ABSENT\n' >"$STATE_OUTPUT_DIR/$label.sha256"
  fi
}
capture_optional_table tender.release_migrations name migration-ledger
capture_optional_table tender.release_plan_snapshots release_id migration-snapshots
chmod 0600 "$STATE_OUTPUT_DIR"/*
