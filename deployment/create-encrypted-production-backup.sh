#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
: "${BACKUP_DIR:?BACKUP_DIR is required}"
: "${BACKUP_ENCRYPTION_KEY_FILE:?BACKUP_ENCRYPTION_KEY_FILE is required}"
[[ "$BACKUP_DIR" = /* ]] || { echo "BACKUP_DIR must be absolute" >&2; exit 64; }
[[ -f "$BACKUP_ENCRYPTION_KEY_FILE" && ! -L "$BACKUP_ENCRYPTION_KEY_FILE" && -r "$BACKUP_ENCRYPTION_KEY_FILE" ]] || { echo "backup encryption key file is unreadable or unsafe" >&2; exit 66; }
key_mode=$(stat -c '%a' "$BACKUP_ENCRYPTION_KEY_FILE")
(( (8#$key_mode & 077) == 0 && (8#$key_mode & 0700) <= 0600 )) || { echo "backup encryption key file must have mode 0600 or stricter" >&2; exit 66; }
mkdir -p "$BACKUP_DIR"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$BACKUP_DIR/wb-tender-$timestamp-$$.dump.gpg"
manifest="$backup.manifest"
manifest_checksum="$manifest.sha256"
plain_hash=$(mktemp "$BACKUP_DIR/.plain-sha.XXXXXX")
verified_hash=$(mktemp "$BACKUP_DIR/.verified-sha.XXXXXX")
cleanup() { rm -f "$plain_hash" "$verified_hash"; }
failed() { status=$?; rm -f "$backup" "$manifest" "$manifest_checksum"; cleanup; exit "$status"; }
trap failed ERR INT TERM
dump_archive() {
  if [[ -n "${BACKUP_SOURCE_CONTAINER:-}" ]]; then
    [[ "${BACKUP_SOURCE_ISOLATED_CLONE:-false}" == true ]] || { echo "container backup source must be an explicitly isolated clone" >&2; return 64; }
    : "${BACKUP_DATABASE_USER:?BACKUP_DATABASE_USER is required for an isolated clone}"
    : "${BACKUP_DATABASE_NAME:?BACKUP_DATABASE_NAME is required for an isolated clone}"
    docker inspect "$BACKUP_SOURCE_CONTAINER" --format '{{.State.Running}}' | grep -qx true
    docker exec "$BACKUP_SOURCE_CONTAINER" pg_dump -Fc -U "$BACKUP_DATABASE_USER" -d "$BACKUP_DATABASE_NAME"
  else
    : "${COMPOSE_FILE:?COMPOSE_FILE is required}"
    : "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required}"
    docker compose -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" exec -T db sh -c 'pg_dump -Fc "$POSTGRES_DB"'
  fi
}
dump_archive \
  | tee >(sha256sum | cut -d' ' -f1 >"$plain_hash") \
  | gpg --batch --yes --pinentry-mode loopback --cipher-algo AES256 --compress-algo none --passphrase-file "$BACKUP_ENCRYPTION_KEY_FILE" --symmetric --output "$backup"
[[ -s "$backup" && -s "$plain_hash" ]] || { echo "encrypted backup was not created" >&2; exit 74; }
gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_ENCRYPTION_KEY_FILE" --decrypt "$backup" \
  | sha256sum | cut -d' ' -f1 >"$verified_hash"
set +o pipefail
gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_ENCRYPTION_KEY_FILE" --decrypt "$backup" \
  | pg_restore -l >/dev/null
list_status=("${PIPESTATUS[@]}")
set -o pipefail
[[ "${list_status[0]}" -eq 0 && "${list_status[1]}" -eq 0 ]] || { echo "decrypted backup catalog verification failed" >&2; exit 74; }
cmp -s "$plain_hash" "$verified_hash" || { echo "backup plaintext digest verification failed" >&2; exit 74; }
{
  printf 'created_utc=%s\n' "$timestamp"
  printf 'archive=%s\n' "${backup##*/}"
  printf 'archive_sha256=%s\n' "$(sha256sum "$backup" | cut -d' ' -f1)"
  printf 'plaintext_sha256=%s\n' "$(cat "$verified_hash")"
  printf 'pg_restore_list_verified=true\n'
  printf 'encryption=gpg-aes256-symmetric-file-key\n'
} >"$manifest"
sha256sum "$backup" "$manifest" >"$manifest_checksum"
trap - ERR INT TERM
cleanup
printf 'BACKUP_TIMESTAMP=%s\nBACKUP_FILE=%s\nBACKUP_MANIFEST=%s\n' "$timestamp" "$backup" "$manifest"
