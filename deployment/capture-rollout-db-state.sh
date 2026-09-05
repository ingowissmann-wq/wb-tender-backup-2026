#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
: "${STATE_OUTPUT_DIR:?STATE_OUTPUT_DIR is required}"
[[ -d "$STATE_OUTPUT_DIR" ]] || { echo "state capture output is unavailable" >&2; exit 66; }
database=()
if [[ "${ROLLOUT_DATABASE_ADMIN_TRUSTED:-false}" == true ]]; then
  for name in PGHOST PGUSER PGDATABASE PGPASSFILE; do
    [[ -n "${!name:-}" ]] || { echo "trusted state capture is missing $name" >&2; exit 64; }
  done
  [[ -f "$PGPASSFILE" && ! -L "$PGPASSFILE" && -r "$PGPASSFILE" ]] || { echo "trusted state capture pgpass is unavailable" >&2; exit 66; }
else
  : "${DATABASE_URL_FILE:?DATABASE_URL_FILE is required}"
  [[ -f "$DATABASE_URL_FILE" && ! -L "$DATABASE_URL_FILE" && -r "$DATABASE_URL_FILE" ]] || { echo "state capture database URL is unavailable" >&2; exit 66; }
  database=("$(cat "$DATABASE_URL_FILE")")
fi
pg_dump "${database[@]}" --schema-only --no-owner --no-acl | sed '/^\\restrict /d;/^\\unrestrict /d' | sha256sum | cut -d' ' -f1 >"$STATE_OUTPUT_DIR/schema.sha256"
psql "${database[@]}" -Atv ON_ERROR_STOP=1 -c "SELECT encode(digest(coalesce(jsonb_agg(to_jsonb(p) ORDER BY code)::text,''),'sha256'),'hex') FROM saas.plans p WHERE code IN ('CORE','NORMAL','PROFESSIONAL','ENTERPRISE')" >"$STATE_OUTPUT_DIR/plans.sha256"
capture_optional_table() {
  table=$1 order=$2 label=$3
  present=$(psql "${database[@]}" -Atv ON_ERROR_STOP=1 -c "SELECT to_regclass('$table') IS NOT NULL")
  printf '%s\n' "$present" >"$STATE_OUTPUT_DIR/$label.present"
  if [[ "$present" == t ]]; then
    psql "${database[@]}" -Atv ON_ERROR_STOP=1 -c "COPY (SELECT to_jsonb(x)::text FROM $table x ORDER BY $order) TO STDOUT" | sha256sum | cut -d' ' -f1 >"$STATE_OUTPUT_DIR/$label.sha256"
  else
    printf 'ABSENT\n' >"$STATE_OUTPUT_DIR/$label.sha256"
  fi
}
capture_optional_table tender.release_migrations name migration-ledger
capture_optional_table tender.release_plan_snapshots release_id migration-snapshots
chmod 0600 "$STATE_OUTPUT_DIR"/*
