#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

root=$(git rev-parse --show-toplevel)
temporary=$(mktemp -d /tmp/wb-encrypted-catalog-integration.XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT
mkdir "$temporary/bin"
mkdir "$temporary/gnupg"
chmod 0700 "$temporary/gnupg"
export GNUPGHOME="$temporary/gnupg"

printf 'catalog-integration-key\n' >"$temporary/key"
printf 'wrong-catalog-integration-key\n' >"$temporary/wrong-key"
chmod 0600 "$temporary/key" "$temporary/wrong-key"

cat >"$temporary/bin/pg_restore" <<'SH'
#!/usr/bin/env bash
set -u
[[ "${1:-}" == -l ]] || exit 64
IFS= read -r header || exit 71
[[ "$header" == PGDMP-WB-CATALOG-INTEGRATION ]] || exit 72
[[ "${PG_RESTORE_TEST_MODE:-success}" != fail ]] || exit 73
printf '1; 0 0 SCHEMA - iam postgres\n2; 0 0 SCHEMA - saas postgres\n3; 0 0 SCHEMA - tender postgres\n'
SH
chmod 0755 "$temporary/bin/pg_restore"
export PATH="$temporary/bin:$PATH"

# shellcheck source=../deployment/lib/encrypted-pg-archive.sh
source "$root/deployment/lib/encrypted-pg-archive.sh"

encrypt_valid_stream() {
  {
    printf 'PGDMP-WB-CATALOG-INTEGRATION\n'
    dd if=/dev/zero bs=1M count=64 status=none
  } | gpg --batch --yes --pinentry-mode loopback --cipher-algo AES256 --compress-algo none \
    --passphrase-file "$temporary/key" --symmetric --output "$temporary/valid.dump.gpg"
}
encrypt_invalid_stream() {
  {
    printf 'NOT-A-POSTGRES-ARCHIVE\n'
    dd if=/dev/zero bs=1M count=1 status=none
  } | gpg --batch --yes --pinentry-mode loopback --cipher-algo AES256 --compress-algo none \
    --passphrase-file "$temporary/key" --symmetric --output "$temporary/invalid.dump.gpg"
}
encrypt_plaintext_mismatch_stream() {
  {
    printf 'PGDMP-WB-CATALOG-INTEGRATION\n'
    dd if=/dev/zero bs=1M count=64 status=none
    printf 'changed-tail\n'
  } | gpg --batch --yes --pinentry-mode loopback --cipher-algo AES256 --compress-algo none \
    --passphrase-file "$temporary/key" --symmetric --output "$temporary/plaintext-mismatch.dump.gpg"
}

encrypt_valid_stream
encrypt_invalid_stream
encrypt_plaintext_mismatch_stream

decrypt_valid() {
  gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$temporary/key" --decrypt "$temporary/valid.dump.gpg"
}
decrypt_wrong_key() {
  gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$temporary/wrong-key" --decrypt "$temporary/valid.dump.gpg"
}
decrypt_invalid() {
  gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$temporary/key" --decrypt "$temporary/invalid.dump.gpg"
}

# Prove this fixture exercises GPG's real large-stream early-close behavior.
set +o pipefail
if LC_ALL=C decrypt_valid 2>"$temporary/early-close.stderr" | pg_restore -l >/dev/null; then
  early_close_status=("${PIPESTATUS[@]}")
else
  early_close_status=("${PIPESTATUS[@]}")
fi
set -o pipefail
[[ "${early_close_status[0]}" -eq 2 && "${early_close_status[1]}" -eq 0 ]]
grep -q 'Broken pipe' "$temporary/early-close.stderr"

toc=$(verify_encrypted_pg_archive_catalog decrypt_valid)
[[ "$toc" == *'SCHEMA - iam '* && "$toc" == *'SCHEMA - tender '* ]]

if verify_encrypted_pg_archive_catalog decrypt_wrong_key >/dev/null 2>"$temporary/wrong-key.stderr"; then
  echo "wrong encryption key was accepted" >&2
  exit 1
fi
if verify_encrypted_pg_archive_catalog decrypt_invalid >/dev/null 2>"$temporary/invalid.stderr"; then
  echo "invalid PostgreSQL archive was accepted" >&2
  exit 1
fi
if PG_RESTORE_TEST_MODE=fail verify_encrypted_pg_archive_catalog decrypt_valid >/dev/null 2>"$temporary/pg-restore.stderr"; then
  echo "pg_restore failure was accepted" >&2
  exit 1
fi

expected_cipher_sha=$(sha256sum "$temporary/valid.dump.gpg" | cut -d' ' -f1)
expected_plaintext_sha=$(decrypt_valid | sha256sum | cut -d' ' -f1)
valid_size=$(stat -c '%s' "$temporary/valid.dump.gpg")
cp "$temporary/valid.dump.gpg" "$temporary/corrupt-ciphertext.dump.gpg"
truncate -s $((valid_size - 1)) "$temporary/corrupt-ciphertext.dump.gpg"

verify_candidate() {
  local archive=$1 key=$2 required_cipher_sha=$3 required_plaintext_sha=$4
  [[ "$(sha256sum "$archive" | cut -d' ' -f1)" == "$required_cipher_sha" ]] || return 1
  decrypt_candidate() {
    gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$key" --decrypt "$archive"
  }
  [[ "$(decrypt_candidate | sha256sum | cut -d' ' -f1)" == "$required_plaintext_sha" ]] || return 1
  verify_encrypted_pg_archive_catalog decrypt_candidate >/dev/null
}

verify_candidate "$temporary/valid.dump.gpg" "$temporary/key" "$expected_cipher_sha" "$expected_plaintext_sha"
if verify_candidate "$temporary/corrupt-ciphertext.dump.gpg" "$temporary/key" "$expected_cipher_sha" "$expected_plaintext_sha"; then
  echo "corrupt ciphertext passed the ciphertext checksum gate" >&2
  exit 1
fi
mismatch_cipher_sha=$(sha256sum "$temporary/plaintext-mismatch.dump.gpg" | cut -d' ' -f1)
if verify_candidate "$temporary/plaintext-mismatch.dump.gpg" "$temporary/key" "$mismatch_cipher_sha" "$expected_plaintext_sha"; then
  echo "corrupt plaintext passed the full plaintext checksum gate" >&2
  exit 1
fi

printf '{"passed":true,"largeEarlyCloseAccepted":true,"wrongKeyRejected":true,"invalidArchiveRejected":true,"pgRestoreFailureRejected":true,"ciphertextChecksumRejected":true,"plaintextChecksumRejected":true,"plaintextArchiveWrittenToDisk":false}\n'
