#!/usr/bin/env bash
set -Eeuo pipefail

required=(PRODUCTION_BROWSER_IMAGE PRODUCTION_CANARY_STATE_DIR PRODUCTION_BASE_URL TENDER_UI_BASE TENDER_API_BASE)
for name in "${required[@]}"; do [[ -n "${!name:-}" ]] || { echo "missing required environment: $name" >&2; exit 64; }; done
[[ "$PRODUCTION_BROWSER_IMAGE" == *@sha256:* ]] || { echo "PRODUCTION_BROWSER_IMAGE must be digest pinned" >&2; exit 64; }
[[ "$PRODUCTION_CANARY_STATE_DIR" = /* && -d "$PRODUCTION_CANARY_STATE_DIR" && ! -L "$PRODUCTION_CANARY_STATE_DIR" ]] || {
  echo "PRODUCTION_CANARY_STATE_DIR must be an absolute non-symlink directory" >&2; exit 66;
}
repository=$(git rev-parse --show-toplevel)
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || { echo "production browser checkout is not clean" >&2; exit 65; }
docker image inspect "$PRODUCTION_BROWSER_IMAGE" >/dev/null 2>&1 || { echo "digest-pinned production browser image is unavailable" >&2; exit 69; }

docker run --rm --init --read-only --cap-drop ALL --security-opt no-new-privileges:true --shm-size=1g \
  --tmpfs /tmp:rw,noexec,nosuid,size=512m \
  -v "$repository:/app:ro" -v "$PRODUCTION_CANARY_STATE_DIR:/run/canary:ro" -w /app \
  -e E2E_EMAIL_FILE=/run/canary/email -e E2E_PASSWORD_FILE=/run/canary/password -e E2E_TOTP_FILE=/run/canary/totp \
  -e PRODUCTION_BASE_URL="$PRODUCTION_BASE_URL" -e TENDER_UI_BASE="$TENDER_UI_BASE" -e TENDER_API_BASE="$TENDER_API_BASE" \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  "$PRODUCTION_BROWSER_IMAGE" node scripts/production-iam-browser-canary.mjs
