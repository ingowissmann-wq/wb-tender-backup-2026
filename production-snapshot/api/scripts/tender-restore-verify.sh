#!/usr/bin/env bash
set -euo pipefail

: "${BACKUP_FILE:?BACKUP_FILE is required}"
: "${BACKUP_KEY_FILE:?BACKUP_KEY_FILE is required}"
POSTGRES_IMAGE=${POSTGRES_IMAGE:-postgres:16-alpine}
KEEP_RESTORE=${KEEP_RESTORE:-false}
test -r "$BACKUP_FILE"
test -r "$BACKUP_KEY_FILE"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
name="wb-tender-restore-verify-$stamp"
network="$name"
volume="$name-data"
password=$(openssl rand -hex 32)
cleanup() {
  if [ "$KEEP_RESTORE" != true ]; then
    docker rm -f "$name-db" >/dev/null 2>&1 || true
    docker volume rm "$volume" >/dev/null 2>&1 || true
    docker network rm "$network" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM
docker network create "$network" >/dev/null
docker volume create "$volume" >/dev/null
docker run -d --name "$name-db" --network "$network" -e POSTGRES_USER=restore_admin -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=wb_platform_restore -v "$volume:/var/lib/postgresql/data" "$POSTGRES_IMAGE" >/dev/null
attempt=0
until docker exec "$name-db" pg_isready -U restore_admin -d wb_platform_restore >/dev/null 2>&1; do
  attempt=$((attempt+1)); [ "$attempt" -lt 60 ] || { echo "restore database startup timeout" >&2; exit 1; }; sleep 1
done
openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 -pass "file:$BACKUP_KEY_FILE" -in "$BACKUP_FILE" | \
  docker exec -i "$name-db" pg_restore -U restore_admin -d wb_platform_restore --no-owner --no-acl --exit-on-error
result=$(docker exec "$name-db" psql -U restore_admin -d wb_platform_restore -X -Atc "SELECT json_build_object('tenders',(SELECT count(*) FROM tender.tenders),'documents',(SELECT count(*) FROM tender.enrichment_documents),'packages',(SELECT count(*) FROM tender.bid_packages),'rlsMissing',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname IN('tender','crm','recruiting','tenant_portal','saas') AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attname='tenant_id') AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)))")
printf 'restore_verified timestamp=%s invariants=%s\n' "$stamp" "$result"
