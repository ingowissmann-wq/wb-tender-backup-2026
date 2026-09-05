#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

required=(PRODUCTION_CANARY_STATE_DIR DATABASE_URL_FILE SESSION_PEPPER_FILE FIELD_ENCRYPTION_KEY_FILE)
for name in "${required[@]}"; do [[ -n "${!name:-}" ]] || { echo "missing required environment: $name" >&2; exit 64; }; done

[[ "${TENDER_API_BASE:-/api/tender}" == /api/tender ]] || { echo "production TENDER_API_BASE must be /api/tender" >&2; exit 64; }
export TENDER_API_BASE=/api/tender
export PRODUCTION_SESSION_FILE="$PRODUCTION_CANARY_STATE_DIR/curl.config"

cleanup_canary() {
  status=$?
  trap - EXIT
  set +e
  cleanup_status=0
  absence_status=0
  if [[ -f "$PRODUCTION_CANARY_STATE_DIR/manifest.json" ]]; then
    node scripts/production-iam-canary.mjs cleanup
    cleanup_status=$?
    node scripts/production-iam-canary.mjs verify-absence
    absence_status=$?
  fi
  set -e
  if (( cleanup_status != 0 || absence_status != 0 )); then
    echo "IAM canary cleanup or absence proof failed" >&2
    exit 91
  fi
  exit "$status"
}
trap cleanup_canary EXIT
deployment/production-rollout.sh
