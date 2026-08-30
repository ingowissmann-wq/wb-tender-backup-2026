#!/usr/bin/env bash
set -euo pipefail

: "${PRODUCTION_ROOT:?PRODUCTION_ROOT is required}"
: "${SOURCE_REPOSITORY:?SOURCE_REPOSITORY is required}"
DATABASE_URL_FILE=${DATABASE_URL_FILE:-}
DATABASE_CONTAINER=${DATABASE_CONTAINER:-}
DOCKER_NETWORK=${DOCKER_NETWORK:-}
BACKUP_ROOT=${BACKUP_ROOT:-/srv/wb-green/backups/wb-tender/daily}
BACKUP_KEY_ROOT=${BACKUP_KEY_ROOT:-/srv/wb-green/backup-keys/wb-tender/daily}
RETENTION_DAYS=${RETENTION_DAYS:-14}
DISABLE_RETENTION=${DISABLE_RETENTION:-false}
POSTGRES_IMAGE=${POSTGRES_IMAGE:-postgres:16-alpine}
PG_DUMP_COMPRESS=${PG_DUMP_COMPRESS:-1}
PACKAGE_VERSION=wb-tender-complete-backup/2

case "$BACKUP_ROOT:$BACKUP_KEY_ROOT" in
  /srv/wb-green/backups/wb-tender/*:/srv/wb-green/backup-keys/wb-tender/*) ;;
  *) echo "refusing unsafe backup roots" >&2; exit 64;;
esac
case "$PRODUCTION_ROOT" in
  /srv/wb-tender-production) ;;
  *) echo "refusing unknown production root" >&2; exit 64;;
esac
test "$BACKUP_ROOT" != "$BACKUP_KEY_ROOT"
if test -n "$DATABASE_URL_FILE" && test -n "$DATABASE_CONTAINER"; then
  echo "choose exactly one database source" >&2
  exit 64
elif test -n "$DATABASE_URL_FILE"; then
  test -r "$DATABASE_URL_FILE"
  : "${DOCKER_NETWORK:?DOCKER_NETWORK is required with DATABASE_URL_FILE}"
elif test -n "$DATABASE_CONTAINER"; then
  test "$(docker inspect --format '{{.State.Running}}' "$DATABASE_CONTAINER")" = true
else
  echo "DATABASE_URL_FILE or DATABASE_CONTAINER is required" >&2
  exit 64
fi
test -d "$PRODUCTION_ROOT"
test -f "$PRODUCTION_ROOT/compose.yml"
test -d "$PRODUCTION_ROOT/artifacts"
test -f "$PRODUCTION_ROOT/data/career.db"
test -d "$PRODUCTION_ROOT/secrets"
test -d "$SOURCE_REPOSITORY/.git"
test -z "$(git -C "$SOURCE_REPOSITORY" status --porcelain)"
for tool in docker git openssl sha256sum tar zstd; do command -v "$tool" >/dev/null; done

# A compose file belongs to the non-secret application package only when it
# points at secret files. Direct secret values are rejected fail-closed.
if grep -Eq '(^|[[:space:]-])(POSTGRES_PASSWORD|DATABASE_URL|PORTAL_CREDENTIAL_KEY|SESSION_PEPPER|IAM_FIELD_ENCRYPTION_KEY)[[:space:]]*[:=]' "$PRODUCTION_ROOT/compose.yml"; then
  echo "refusing compose file with inline secret material" >&2
  exit 65
fi
if git -C "$SOURCE_REPOSITORY" ls-tree -r --name-only HEAD | grep -Eq '(^|/)(database_url|db_password|iam_field_key|portal_credential_key|session_pepper|[^/]*\.key)$'; then
  echo "refusing source archive containing a secret filename" >&2
  exit 65
fi

source_commit=$(git -C "$SOURCE_REPOSITORY" rev-parse 'HEAD^{commit}')
source_tree=$(git -C "$SOURCE_REPOSITORY" rev-parse 'HEAD^{tree}')
compose_sha256=$(sha256sum "$PRODUCTION_ROOT/compose.yml" | awk '{print $1}')
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$BACKUP_ROOT/$stamp"
key_target="$BACKUP_KEY_ROOT/$stamp.key"
plain_dump="$target/.wb_platform.dump"
plain_globals="$target/.globals.sql"
staging="$target/.package-staging"

cleanup_plaintext() {
  rm -f -- "$plain_dump" "$plain_globals"
  if test -d "$staging"; then find "$staging" -depth -delete; fi
}
trap cleanup_plaintext EXIT INT TERM
mkdir -p "$target" "$BACKUP_KEY_ROOT" "$staging/application/production/data" "$staging/application/source"
chmod 0700 "$target" "$BACKUP_KEY_ROOT" "$staging"
openssl rand -hex 32 >"$key_target"
chmod 0600 "$key_target"

dump_to_target() {
  mode=$1
  destination=$2
  if test -n "$DATABASE_CONTAINER"; then
    host_destination="$target/${destination#/backup/}"
    docker exec "$DATABASE_CONTAINER" sh -ec 'if [ "$1" = data ]; then exec pg_dump --format=custom --compress="$2" --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"; else exec pg_dumpall --globals-only --no-role-passwords -U "$POSTGRES_USER" --database="dbname=$POSTGRES_DB"; fi' backup "$mode" "$PG_DUMP_COMPRESS" \
      >"$host_destination"
  else
    docker run --rm --network "$DOCKER_NETWORK" \
      -v "$DATABASE_URL_FILE:/run/secrets/database_url:ro" \
      -v "$target:/backup:rw" "$POSTGRES_IMAGE" \
      sh -ec 'url=$(cat /run/secrets/database_url); if [ "$1" = data ]; then exec pg_dump --format=custom --compress="$2" --no-owner --no-acl --file="$3" "$url"; else exec pg_dumpall --globals-only --no-role-passwords --file="$3" --database="$url"; fi' backup "$mode" "$PG_DUMP_COMPRESS" "$destination"
  fi
}

encrypt_file() {
  source_file=$1
  destination_file=$2
  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 250000 \
    -pass "file:$key_target" -in "$source_file" -out "$destination_file"
}

dump_to_target data /backup/.wb_platform.dump
chmod 0600 "$plain_dump"
encrypt_file "$plain_dump" "$target/wb_platform.dump.enc"
rm -f -- "$plain_dump"
dump_to_target globals /backup/.globals.sql
chmod 0600 "$plain_globals"
encrypt_file "$plain_globals" "$target/globals.sql.enc"
rm -f -- "$plain_globals"

# Only reproducible source and discovered non-secret persistent paths enter the
# application payload. Physical PGDATA and historical repair trees are absent.
install -m 0600 "$PRODUCTION_ROOT/compose.yml" "$staging/application/production/compose.yml"
cp -a "$PRODUCTION_ROOT/artifacts" "$staging/application/production/artifacts"
install -m 0600 "$PRODUCTION_ROOT/data/career.db" "$staging/application/production/data/career.db"
if test -f "$PRODUCTION_ROOT/canary/data/career.db"; then
  mkdir -p "$staging/application/production/canary/data"
  install -m 0600 "$PRODUCTION_ROOT/canary/data/career.db" "$staging/application/production/canary/data/career.db"
fi
git -C "$SOURCE_REPOSITORY" archive --format=tar HEAD | zstd -q -T0 -o "$staging/application/source/source.tar.zst"
printf 'package_version=%s\nsource_commit=%s\nsource_tree=%s\ncompose_sha256=%s\n' \
  "$PACKAGE_VERSION" "$source_commit" "$source_tree" "$compose_sha256" \
  >"$staging/application/source/identity.env"

: >"$staging/application/container-images.tsv"
for container in wb-tender-production-api wb-tender-production-db wb-tender-production-scheduler wb-tender-production-worker; do
  test "$(docker inspect --format '{{.State.Running}}' "$container")" = true
  docker inspect --format '{{.Name}}\t{{.Config.Image}}\t{{.Image}}' "$container" \
    >>"$staging/application/container-images.tsv"
done

# Secret material is streamed into its own encrypted archive and never enters
# the application/source payload.
application_archive="$target/application.tar.zst.enc"
secrets_archive="$target/secrets.tar.zst.enc"
tar -C "$staging" -cf - application | zstd -q -T0 | \
  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 250000 -pass "file:$key_target" -out "$application_archive"

secret_paths=(secrets)
if test -d "$PRODUCTION_ROOT/canary/secrets"; then secret_paths+=(canary/secrets); fi
tar -C "$PRODUCTION_ROOT" -cf - "${secret_paths[@]}" | zstd -q -T0 | \
  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 250000 -pass "file:$key_target" -out "$secrets_archive"

printf '{"packageVersion":"%s","createdAt":"%s","encrypted":true,"logicalFormat":"custom","sourceCommit":"%s","sourceTree":"%s","composeSha256":"%s","retentionDays":%s,"secretsSeparated":true,"externalSubmission":false}\n' \
  "$PACKAGE_VERSION" "$stamp" "$source_commit" "$source_tree" "$compose_sha256" "$RETENTION_DAYS" \
  >"$target/manifest.json"
(cd "$target" && sha256sum application.tar.zst.enc globals.sql.enc manifest.json secrets.tar.zst.enc wb_platform.dump.enc >"$staging/SHA256SUMS")
encrypt_file "$staging/SHA256SUMS" "$target/SHA256SUMS.enc"

set +e
openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 -pass "file:$key_target" -in "$target/wb_platform.dump.enc" | \
  docker run --rm -i "$POSTGRES_IMAGE" pg_restore --list >/dev/null
list_status=("${PIPESTATUS[@]}")
set -e
if [ "${list_status[1]}" -ne 0 ]; then echo "restore list verification failed" >&2; exit 1; fi
openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 -pass "file:$key_target" -in "$application_archive" | zstd -dq | tar -tf - >/dev/null
openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 -pass "file:$key_target" -in "$secrets_archive" | zstd -dq | tar -tf - >/dev/null
openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 -pass "file:$key_target" \
  -in "$target/globals.sql.enc" -out "$staging/globals.verify.sql"
test -s "$staging/globals.verify.sql"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 -pass "file:$key_target" \
  -in "$target/SHA256SUMS.enc" -out "$staging/SHA256SUMS.verify"
(cd "$target" && sha256sum -c "$staging/SHA256SUMS.verify")
chmod 0600 "$target"/*

if [ "$DISABLE_RETENTION" != true ]; then
  find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20??????T??????Z' -mtime "+$RETENTION_DAYS" -exec rm -rf -- {} +
  find "$BACKUP_KEY_ROOT" -mindepth 1 -maxdepth 1 -type f -name '20??????T??????Z.key' -mtime "+$RETENTION_DAYS" -delete
fi
echo "backup_complete timestamp=$stamp package_version=$PACKAGE_VERSION encrypted=true secrets_separated=true restore_list_verified=true"
