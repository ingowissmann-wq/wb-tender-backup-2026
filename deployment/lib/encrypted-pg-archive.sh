#!/usr/bin/env bash

# Verify a PostgreSQL custom archive catalog without writing plaintext to disk.
# The decrypt command is expected to be a shell function or executable that
# writes the archive plaintext to stdout.
verify_encrypted_pg_archive_catalog() (
  if (( $# != 1 )); then
    echo "verify_encrypted_pg_archive_catalog requires one decrypt command" >&2
    return 64
  fi

  local decrypt_command=$1
  local diagnostic_file
  local -a pipeline_status
  diagnostic_file=$(mktemp "${TMPDIR:-/tmp}/wb-tender-gpg-catalog.XXXXXX") || return 70
  trap 'rm -f -- "$diagnostic_file"' EXIT

  # pg_restore intentionally stops after reading the catalog. GPG 2.x reports
  # that legitimate early close as exit 2 plus a Broken-pipe diagnostic.
  set +o pipefail
  if LC_ALL=C "$decrypt_command" 2>"$diagnostic_file" | pg_restore -l; then
    pipeline_status=("${PIPESTATUS[@]}")
  else
    pipeline_status=("${PIPESTATUS[@]}")
  fi
  set -o pipefail

  local decrypt_status=${pipeline_status[0]:-125}
  local pg_restore_status=${pipeline_status[1]:-125}
  if (( pg_restore_status != 0 )); then
    cat "$diagnostic_file" >&2
    echo "pg_restore catalog validation failed (status $pg_restore_status)" >&2
    return 1
  fi

  if (( decrypt_status == 0 )); then
    return 0
  fi

  if (( decrypt_status == 2 )) &&
    grep -Eq '^(gpg: )?(\[stdout\]: )?(write error|handle plaintext failed): Broken pipe$' "$diagnostic_file"; then
    return 0
  fi

  cat "$diagnostic_file" >&2
  echo "archive decryption failed during catalog validation (status $decrypt_status)" >&2
  return 1
)
