#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL_FILE:?DATABASE_URL_FILE is required}"
: "${DOCKER_NETWORK:?DOCKER_NETWORK is required}"
BACKUP_ROOT=${BACKUP_ROOT:-/srv/wb-green/backups/wb-tender/daily}
BACKUP_KEY_ROOT=${BACKUP_KEY_ROOT:-/srv/wb-green/backup-keys/wb-tender/daily}
RETENTION_DAYS=${RETENTION_DAYS:-14}
DISABLE_RETENTION=${DISABLE_RETENTION:-false}
POSTGRES_IMAGE=${POSTGRES_IMAGE:-postgres:16-alpine}
PG_DUMP_COMPRESS=${PG_DUMP_COMPRESS:-1}

case "$BACKUP_ROOT:$BACKUP_KEY_ROOT" in
  /srv/wb-green/backups/wb-tender/*:/srv/wb-green/backup-keys/wb-tender/*) ;;
  *) echo "refusing unsafe backup roots" >&2; exit 64;;
esac
test -r "$DATABASE_URL_FILE"
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$BACKUP_ROOT/$stamp"
key_target="$BACKUP_KEY_ROOT/$stamp.key"
plain_dump="$target/.wb_platform.dump"
plain_globals="$target/.globals.sql"
cleanup_plaintext() {
  rm -f -- "$plain_dump" "$plain_globals"
}
trap cleanup_plaintext EXIT INT TERM
mkdir -p "$target" "$BACKUP_KEY_ROOT"
chmod 0700 "$target" "$BACKUP_KEY_ROOT"
openssl rand -hex 32 >"$key_target"
chmod 0600 "$key_target"

dump_to_target() {
  mode=$1
  destination=$2
  docker run --rm --network "$DOCKER_NETWORK" \
    -v "$DATABASE_URL_FILE:/run/secrets/database_url:ro" \
    -v "$target:/backup:rw" "$POSTGRES_IMAGE" \
    sh -ec 'url=$(cat /run/secrets/database_url); if [ "$1" = data ]; then exec pg_dump --format=custom --compress="$2" --no-owner --no-acl --file="$3" "$url"; else exec pg_dumpall --globals-only --no-role-passwords --file="$3" --database="$url"; fi' backup "$mode" "$PG_DUMP_COMPRESS" "$destination"
}

# Keep the long database export independent from the encryption process. A
# late downstream pipe close otherwise leaves pg_dump with only EPIPE and no
# recoverable archive. The temporary archives inherit umask 0077 and are
# unconditionally removed by the trap before the service exits.
dump_to_target data /backup/.wb_platform.dump
chmod 0600 "$plain_dump"
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 250000 -pass "file:$key_target" -in "$plain_dump" -out "$target/wb_platform.dump.enc"
rm -f -- "$plain_dump"
dump_to_target globals /backup/.globals.sql
chmod 0600 "$plain_globals"
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 250000 -pass "file:$key_target" -in "$plain_globals" -out "$target/globals.sql.enc"
rm -f -- "$plain_globals"
(cd "$target" && sha256sum wb_platform.dump.enc globals.sql.enc >SHA256SUMS)
set +e
openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 -pass "file:$key_target" -in "$target/wb_platform.dump.enc" | \
  docker run --rm -i "$POSTGRES_IMAGE" pg_restore --list >/dev/null
list_status=("${PIPESTATUS[@]}")
set -e
# pg_restore --list intentionally closes stdin after the archive TOC. OpenSSL
# can therefore report a downstream broken pipe although pg_restore proved the
# archive header/TOC readable. The pg_restore status is the authoritative gate;
# the subsequent full isolated restore verifies the complete encrypted stream.
if [ "${list_status[1]}" -ne 0 ]; then echo "restore list verification failed" >&2; exit 1; fi
printf '{"createdAt":"%s","encrypted":true,"logicalFormat":"custom","retentionDays":%s,"restoreListVerified":true}\n' "$stamp" "$RETENTION_DAYS" >"$target/manifest.json"
chmod 0600 "$target"/*

# Retention is constrained to timestamp directories below the two exact WB
# Tender backup roots. The pre-change and release rollback backups live in
# separate roots and are never touched here.
if [ "$DISABLE_RETENTION" != true ]; then
  find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20??????T??????Z' -mtime "+$RETENTION_DAYS" -exec rm -rf -- {} +
  find "$BACKUP_KEY_ROOT" -mindepth 1 -maxdepth 1 -type f -name '20??????T??????Z.key' -mtime "+$RETENTION_DAYS" -delete
fi
echo "backup_complete timestamp=$stamp encrypted=true restore_list_verified=true"
