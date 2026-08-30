#!/usr/bin/env bash
set -euo pipefail

: "${BACKUP_KEY_FILE:?BACKUP_KEY_FILE is required}"
BACKUP_DIR=${BACKUP_DIR:-}
BACKUP_FILE=${BACKUP_FILE:-}
POSTGRES_IMAGE=${POSTGRES_IMAGE:-postgres:16-alpine}
KEEP_RESTORE=${KEEP_RESTORE:-false}
EXPECTED_TENDERS=${EXPECTED_TENDERS:-}
EXPECTED_DOCUMENTS=${EXPECTED_DOCUMENTS:-}
EXPECTED_PACKAGES=${EXPECTED_PACKAGES:-}
PACKAGE_VERSION=wb-tender-complete-backup/2

if test -n "$BACKUP_DIR"; then
  test -d "$BACKUP_DIR"
  BACKUP_FILE=${BACKUP_FILE:-$BACKUP_DIR/wb_platform.dump.enc}
  for required in SHA256SUMS.enc application.tar.zst.enc globals.sql.enc manifest.json secrets.tar.zst.enc wb_platform.dump.enc; do
    test -r "$BACKUP_DIR/$required"
  done
else
  : "${BACKUP_FILE:?BACKUP_FILE or BACKUP_DIR is required}"
fi
test -r "$BACKUP_FILE"
test -r "$BACKUP_KEY_FILE"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
name="wb-tender-restore-verify-$stamp"
network="$name"
volume="$name-data"
password=$(openssl rand -hex 32)
package_stage=$(mktemp -d -t wb-tender-package-verify.XXXXXXXX)
cleanup() {
  if [ "$KEEP_RESTORE" != true ]; then
    docker rm -f "$name-db" >/dev/null 2>&1 || true
    docker volume rm "$volume" >/dev/null 2>&1 || true
    docker network rm "$network" >/dev/null 2>&1 || true
  fi
  if test -d "$package_stage"; then find "$package_stage" -depth -delete; fi
}
trap cleanup EXIT INT TERM

package_verified=false
if test -n "$BACKUP_DIR"; then
  mkdir -p "$package_stage/application" "$package_stage/secrets"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 -pass "file:$BACKUP_KEY_FILE" \
    -in "$BACKUP_DIR/SHA256SUMS.enc" -out "$package_stage/SHA256SUMS"
  (cd "$BACKUP_DIR" && sha256sum -c "$package_stage/SHA256SUMS")
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 -pass "file:$BACKUP_KEY_FILE" \
    -in "$BACKUP_DIR/application.tar.zst.enc" -out "$package_stage/application.tar.zst"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 -pass "file:$BACKUP_KEY_FILE" \
    -in "$BACKUP_DIR/secrets.tar.zst.enc" -out "$package_stage/secrets.tar.zst"
  zstd -dc "$package_stage/application.tar.zst" | tar -tf - >"$package_stage/application.members"
  awk 'BEGIN{ok=1} /^\//{ok=0} /(^|\/)\.\.(\/|$)/{ok=0} !/^application(\/|$)/{ok=0} END{exit ok?0:1}' "$package_stage/application.members"
  zstd -dc "$package_stage/secrets.tar.zst" | tar -tf - >"$package_stage/secrets.members"
  awk 'BEGIN{ok=1} /^\//{ok=0} /(^|\/)\.\.(\/|$)/{ok=0} !/^(secrets|canary\/secrets)(\/|$)/{ok=0} END{exit ok?0:1}' "$package_stage/secrets.members"
  zstd -dc "$package_stage/application.tar.zst" | tar -xf - -C "$package_stage/application"
  zstd -dc "$package_stage/secrets.tar.zst" | tar -xf - -C "$package_stage/secrets"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 -pass "file:$BACKUP_KEY_FILE" \
    -in "$BACKUP_DIR/globals.sql.enc" >"$package_stage/globals.sql"
  test -s "$package_stage/globals.sql"
  test -f "$package_stage/application/application/production/compose.yml"
  test -d "$package_stage/application/application/production/artifacts"
  test -f "$package_stage/application/application/production/data/career.db"
  test -f "$package_stage/application/application/source/source.tar.zst"
  test -f "$package_stage/application/application/source/identity.env"
  test -f "$package_stage/application/application/container-images.tsv"
  test -d "$package_stage/secrets/secrets"
  for secret_name in database_url db_password iam_field_key portal_credential_key session_pepper; do
    test -f "$package_stage/secrets/secrets/$secret_name"
  done
  test ! -e "$package_stage/application/application/production/secrets"
  zstd -dc "$package_stage/application/application/source/source.tar.zst" | tar -tf - >/dev/null
  grep -Fqx "package_version=$PACKAGE_VERSION" "$package_stage/application/application/source/identity.env"
  package_verified=true
fi

docker network create "$network" >/dev/null
docker volume create "$volume" >/dev/null
docker run -d --name "$name-db" --network "$network" \
  -e POSTGRES_USER=restore_admin -e POSTGRES_PASSWORD="$password" \
  -e POSTGRES_DB=wb_platform_restore -v "$volume:/var/lib/postgresql/data" \
  "$POSTGRES_IMAGE" >/dev/null
attempt=0
until docker exec "$name-db" pg_isready -U restore_admin -d wb_platform_restore >/dev/null 2>&1; do
  attempt=$((attempt+1)); [ "$attempt" -lt 60 ] || { echo "restore database startup timeout" >&2; exit 1; }; sleep 1
done
openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 -pass "file:$BACKUP_KEY_FILE" -in "$BACKUP_FILE" | \
  docker exec -i "$name-db" pg_restore -U restore_admin -d wb_platform_restore --no-owner --no-acl --exit-on-error
result=$(docker exec "$name-db" psql -U restore_admin -d wb_platform_restore -X -Atc "SELECT json_build_object('tenders',(SELECT count(*) FROM tender.tenders),'documents',(SELECT count(*) FROM tender.enrichment_documents),'packages',(SELECT count(*) FROM tender.bid_packages),'rlsMissing',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname IN('tender','crm','recruiting','tenant_portal','saas') AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attname='tenant_id') AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)))")
counts=$(docker exec "$name-db" psql -U restore_admin -d wb_platform_restore -X -Atc "SELECT (SELECT count(*) FROM tender.tenders)::text||'|'||(SELECT count(*) FROM tender.enrichment_documents)::text||'|'||(SELECT count(*) FROM tender.bid_packages)::text")
IFS='|' read -r actual_tenders actual_documents actual_packages <<<"$counts"
test -z "$EXPECTED_TENDERS" || test "$actual_tenders" = "$EXPECTED_TENDERS"
test -z "$EXPECTED_DOCUMENTS" || test "$actual_documents" = "$EXPECTED_DOCUMENTS"
test -z "$EXPECTED_PACKAGES" || test "$actual_packages" = "$EXPECTED_PACKAGES"
test "$(docker exec "$name-db" psql -U restore_admin -d wb_platform_restore -X -Atc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname IN('tender','crm','recruiting','tenant_portal','saas') AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attname='tenant_id') AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)")" = 0
printf 'restore_verified timestamp=%s package_verified=%s invariants=%s\n' "$stamp" "$package_verified" "$result"
