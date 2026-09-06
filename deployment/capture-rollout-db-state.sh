#!/bin/sh
set -eu
umask 077
: "${STATE_OUTPUT_DIR:?STATE_OUTPUT_DIR is required}"
[ -d "$STATE_OUTPUT_DIR" ] || { echo "state capture output is unavailable" >&2; exit 66; }

trusted=false
database_url=
if [ "${ROLLOUT_DATABASE_ADMIN_TRUSTED:-false}" = true ]; then
  trusted=true
  : "${PGHOST:?trusted state capture is missing PGHOST}"
  : "${PGUSER:?trusted state capture is missing PGUSER}"
  : "${PGDATABASE:?trusted state capture is missing PGDATABASE}"
  : "${PGPASSFILE:?trusted state capture is missing PGPASSFILE}"
  [ -f "$PGPASSFILE" ] && [ ! -L "$PGPASSFILE" ] && [ -r "$PGPASSFILE" ] \
    || { echo "trusted state capture pgpass is unavailable" >&2; exit 66; }
else
  : "${DATABASE_URL_FILE:?DATABASE_URL_FILE is required}"
  [ -f "$DATABASE_URL_FILE" ] && [ ! -L "$DATABASE_URL_FILE" ] && [ -r "$DATABASE_URL_FILE" ] \
    || { echo "state capture database URL is unavailable" >&2; exit 66; }
  database_url=$(cat "$DATABASE_URL_FILE")
fi

run_pg_dump() {
  if [ "$trusted" = true ]; then pg_dump "$@"; else pg_dump "$database_url" "$@"; fi
}
run_psql() {
  if [ "$trusted" = true ]; then psql "$@"; else psql "$database_url" "$@"; fi
}

run_pg_dump --schema-only --no-owner --no-acl | sed '/^\\restrict /d;/^\\unrestrict /d' | sha256sum | cut -d' ' -f1 >"$STATE_OUTPUT_DIR/schema.sha256"
run_psql -Atv ON_ERROR_STOP=1 -c "SELECT encode(digest(coalesce(jsonb_agg(to_jsonb(p) ORDER BY code)::text,''),'sha256'),'hex') FROM saas.plans p WHERE code IN ('CORE','NORMAL','PROFESSIONAL','ENTERPRISE')" >"$STATE_OUTPUT_DIR/plans.sha256"
capture_optional_table() {
  capture_table=$1
  capture_order=$2
  capture_label=$3
  capture_present=$(run_psql -Atv ON_ERROR_STOP=1 -c "SELECT to_regclass('$capture_table') IS NOT NULL")
  printf '%s\n' "$capture_present" >"$STATE_OUTPUT_DIR/$capture_label.present"
  if [ "$capture_present" = t ]; then
    run_psql -Atv ON_ERROR_STOP=1 -c "COPY (SELECT to_jsonb(x)::text FROM $capture_table x ORDER BY $capture_order) TO STDOUT" | sha256sum | cut -d' ' -f1 >"$STATE_OUTPUT_DIR/$capture_label.sha256"
  else
    printf 'ABSENT\n' >"$STATE_OUTPUT_DIR/$capture_label.sha256"
  fi
}
capture_optional_table tender.release_migrations name migration-ledger
capture_optional_table tender.release_plan_snapshots release_id migration-snapshots
chmod 0600 "$STATE_OUTPUT_DIR"/*
