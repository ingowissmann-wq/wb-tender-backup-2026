#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $# == 3 ]] || exit 64
client=$1
key=$2
directory=$3
[[ "$client" =~ ^wb-tender-production-release-db-client-[a-f0-9]{7,40}$ ]] || exit 64
[[ "$directory" == /srv/wb-tender-production/backups/scheduled-* && -d "$directory" && ! -L "$directory" ]] || exit 64
[[ -f "$key" && ! -L "$key" && "$(stat -c %a "$key")" == 600 ]] || exit 64
source "$(dirname -- "${BASH_SOURCE[0]}")/lib/encrypted-pg-archive.sh"
export GNUPGHOME="$directory/gnupg"
mkdir -m 700 "$GNUPGHOME"
backup=$directory/database.dump.gpg
[[ ! -e "$backup" ]] || exit 65
pg_restore() { docker exec -i "$client" pg_restore "$@"; }
decrypt() { gpg --no-options --no-symkey-cache --batch --quiet --pinentry-mode loopback --passphrase-file "$key" --decrypt "$backup"; }
# A failed partial encrypted archive and its diagnostics are retained for review.
docker exec "$client" pg_dump -Fc -Z3 --lock-wait-timeout=10000 | tee >(sha256sum | cut -d' ' -f1 >"$directory/plaintext.sha256") | gpg --no-options --no-symkey-cache --batch --pinentry-mode loopback --cipher-algo AES256 --compress-algo none --passphrase-file "$key" --symmetric --output "$backup"
[[ -s "$directory/plaintext.sha256" ]]
[[ "$(decrypt | sha256sum | cut -d' ' -f1)" == "$(cat "$directory/plaintext.sha256")" ]]
verify_encrypted_pg_archive_catalog decrypt >"$directory/catalog.txt"
printf 'created_utc=%s\narchive=database.dump.gpg\narchive_sha256=%s\nplaintext_sha256=%s\npg_restore_list_verified=true\nencryption=gpg-aes256-symmetric-file-key\n' "$(date -u +%Y%m%dT%H%M%SZ)" "$(sha256sum "$backup" | cut -d' ' -f1)" "$(cat "$directory/plaintext.sha256")" >"$backup.manifest"
sha256sum "$backup" "$backup.manifest" >"$backup.manifest.sha256"
sha256sum -c "$backup.manifest.sha256"
