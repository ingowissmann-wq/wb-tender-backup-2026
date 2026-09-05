#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

required=(COMPOSE_FILE COMPOSE_PROJECT_NAME RELEASE_IMAGE POSTGRES_IMAGE DATABASE_URL_FILE SESSION_PEPPER_FILE FIELD_ENCRYPTION_KEY_FILE BACKUP_DIR BACKUP_ENCRYPTION_KEY_FILE REHEARSAL_EVIDENCE OPERATOR_APPROVAL PRODUCTION_SESSION_FILE PRODUCTION_CANARY_STATE_DIR PRODUCTION_BASE_URL ROLLOUT_STATE_DIR EXPECTED_COMMIT EXPECTED_TREE EXPECTED_RELEASE_IMAGE_ID EXPECTED_RELEASE_IMAGE_DIGEST EXPECTED_EVIDENCE_SHA256)
for name in "${required[@]}"; do [[ -n "${!name:-}" ]] || { echo "missing required environment: $name" >&2; exit 64; }; done
[[ "${TENDER_API_BASE:-/api/tender}" == /api/tender ]] || { echo "production TENDER_API_BASE must be /api/tender" >&2; exit 64; }
export TENDER_API_BASE=/api/tender
repository=$(git rev-parse --show-toplevel)
[[ "$BACKUP_DIR" = /* && "$BACKUP_DIR" != "$repository"* ]] || { echo "BACKUP_DIR must be absolute and outside checkout" >&2; exit 64; }
[[ "$ROLLOUT_STATE_DIR" = /* && "$ROLLOUT_STATE_DIR" != "$repository"* ]] || { echo "ROLLOUT_STATE_DIR must be absolute and outside checkout" >&2; exit 64; }
[[ "$PRODUCTION_CANARY_STATE_DIR" = /* && "$PRODUCTION_CANARY_STATE_DIR" != "$repository"* ]] || { echo "PRODUCTION_CANARY_STATE_DIR must be absolute and outside checkout" >&2; exit 64; }
[[ "$PRODUCTION_SESSION_FILE" == "$PRODUCTION_CANARY_STATE_DIR/curl.config" ]] || { echo "PRODUCTION_SESSION_FILE must be the prepared IAM canary curl config" >&2; exit 64; }
[[ -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] || { echo "compose file must be a regular non-symlink file" >&2; exit 66; }
for name in RELEASE_IMAGE POSTGRES_IMAGE; do [[ "${!name}" == *@sha256:* ]] || { echo "$name must be digest pinned" >&2; exit 64; }; done
export EXTERNAL_SUBMISSION_ENABLED=false WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false
export ACTUAL_COMMIT ACTUAL_TREE CHECKOUT_CLEAN ACTUAL_RELEASE_IMAGE_ID ACTUAL_RELEASE_IMAGE_REVISION ACTUAL_RELEASE_IMAGE_TREE
ACTUAL_COMMIT=$(git rev-parse HEAD)
ACTUAL_TREE=$(git rev-parse HEAD^{tree})
CHECKOUT_CLEAN=true
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || CHECKOUT_CLEAN=false
ACTUAL_RELEASE_IMAGE_ID=$(docker image inspect "$RELEASE_IMAGE" --format '{{.Id}}')
ACTUAL_RELEASE_IMAGE_REVISION=$(docker image inspect "$RELEASE_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
ACTUAL_RELEASE_IMAGE_TREE=$(docker image inspect "$RELEASE_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.source-tree"}}')
VERIFY_ROLLOUT_BINDING_PHASE=pre-canary node scripts/verify-rollout-binding.mjs

project=$COMPOSE_PROJECT_NAME
state_dir="$ROLLOUT_STATE_DIR/${EXPECTED_COMMIT}-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 0700 -p "$state_dir/before" "$state_dir/after-rollback"
printf 'EXTERNAL_SUBMISSION_ENABLED=false\nWB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false\n' >"$state_dir/safety.env"

backup_result=$(COMPOSE_FILE="$COMPOSE_FILE" COMPOSE_PROJECT_NAME="$project" BACKUP_DIR="$BACKUP_DIR" BACKUP_ENCRYPTION_KEY_FILE="$BACKUP_ENCRYPTION_KEY_FILE" deployment/create-encrypted-production-backup.sh)
backup=$(printf '%s\n' "$backup_result" | sed -n 's/^BACKUP_FILE=//p')
manifest=$(printf '%s\n' "$backup_result" | sed -n 's/^BACKUP_MANIFEST=//p')
[[ -n "$backup" && -s "$backup" && -s "$manifest" && -s "$manifest.sha256" ]] || { echo "verified encrypted backup was not created" >&2; exit 74; }

isolated_result="$state_dir/isolated-restore.result"
BACKUP_FILE="$backup" BACKUP_MANIFEST="$manifest" BACKUP_MANIFEST_SHA256="$manifest.sha256" \
  BACKUP_ENCRYPTION_KEY_FILE="$BACKUP_ENCRYPTION_KEY_FILE" POSTGRES_IMAGE="$POSTGRES_IMAGE" RELEASE_IMAGE="$RELEASE_IMAGE" \
  RELEASE_ID="$EXPECTED_COMMIT" ISOLATED_RESTORE_RESULT_FILE="$isolated_result" deployment/verify-fresh-backup-restore.sh
grep -qx 'RESULT=PASS' "$isolated_result" || { echo "fresh backup isolated restore did not pass" >&2; exit 78; }

for service in api worker scheduler; do
  container=$(docker compose -p "$project" -f "$COMPOSE_FILE" ps -q "$service")
  [[ -n "$container" ]] || { echo "previous service is absent: $service" >&2; exit 78; }
  docker inspect "$container" --format '{{.Image}}' >"$state_dir/before/$service.image-id"
  docker inspect "$container" --format '{{.RestartCount}}' >"$state_dir/before/$service.restart-count"
  docker inspect "$container" --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' >"$state_dir/before/$service.state"
done
capture_db_state() {
  output=$1
  docker compose -p "$project" -f "$COMPOSE_FILE" run --rm -T \
    -v "$DATABASE_URL_FILE:/run/secrets/database_url:ro" -v "$output:/state" \
    -e DATABASE_URL_FILE=/run/secrets/database_url -e STATE_OUTPUT_DIR=/state tools deployment/capture-rollout-db-state.sh
}
capture_db_state "$state_dir/before"
ledger_existed=false; snapshot_existed=false
[[ "$(cat "$state_dir/before/migration-ledger.present")" != t ]] || ledger_existed=true
[[ "$(cat "$state_dir/before/migration-snapshots.present")" != t ]] || snapshot_existed=true

rollback() {
  original_status=$?
  trap - ERR INT TERM
  set +e
  emergency=0
  node scripts/production-iam-canary.mjs cleanup
  canary_cleanup_status=$?
  node scripts/production-iam-canary.mjs verify-absence
  canary_absence_status=$?
  if (( canary_cleanup_status != 0 || canary_absence_status != 0 )); then echo "ROLLBACK_ERROR: IAM canary cleanup/absence proof failed" >&2; emergency=1; fi
  docker compose -p "$project" -f "$COMPOSE_FILE" stop -t 30 api worker scheduler
  service_stop_status=$?
  if (( service_stop_status != 0 )); then echo "ROLLBACK_ERROR: candidate services did not stop" >&2; emergency=1; fi
  docker compose -p "$project" -f "$COMPOSE_FILE" run --rm -T \
    -v "$DATABASE_URL_FILE:/run/secrets/database_url:ro" -e DATABASE_URL_FILE=/run/secrets/database_url \
    tools deployment/drain-runtime-database-sessions.sh | tee "$state_dir/runtime-session-drain.log"
  runtime_drain_status=$?
  if (( runtime_drain_status != 0 )); then echo "ROLLBACK_ERROR: runtime database sessions did not drain" >&2; emergency=1; fi
  migration_rollback_status=1
  if (( runtime_drain_status == 0 )); then
    docker compose -p "$project" -f "$COMPOSE_FILE" run --rm -T \
      -v "$DATABASE_URL_FILE:/run/secrets/database_url:ro" -v "$state_dir/migrations.log:/state/migrations.log:ro" \
      -e DATABASE_URL_FILE=/run/secrets/database_url -e APPLIED_MIGRATIONS_FILE=/state/migrations.log \
      -e RELEASE_ID="$EXPECTED_COMMIT" -e LEDGER_EXISTED_BEFORE="$ledger_existed" -e SNAPSHOT_EXISTED_BEFORE="$snapshot_existed" \
      tools deployment/rollback-applied-release-migrations.sh
    migration_rollback_status=$?
  fi
  if (( migration_rollback_status != 0 )); then echo "ROLLBACK_ERROR: reverse migration failed" >&2; emergency=1; fi
  override="$state_dir/rollback-images.compose.yml"
  {
    printf 'services:\n'
    for service in api worker scheduler; do printf '  %s:\n    image: %s\n' "$service" "$(cat "$state_dir/before/$service.image-id")"; done
  } >"$override"
  docker compose -p "$project" -f "$COMPOSE_FILE" -f "$override" up -d --no-deps --force-recreate api worker scheduler
  service_restore_status=$?
  if (( service_restore_status != 0 )); then echo "ROLLBACK_ERROR: exact service image restoration failed" >&2; emergency=1; fi
  capture_db_state "$state_dir/after-rollback"
  snapshot_status=$?
  if (( snapshot_status != 0 )); then echo "ROLLBACK_ERROR: verification snapshot failed" >&2; emergency=1; fi
  if (( snapshot_status == 0 )); then
    for item in schema.sha256 plans.sha256 migration-ledger.present migration-ledger.sha256 migration-snapshots.present migration-snapshots.sha256; do
      cmp -s "$state_dir/before/$item" "$state_dir/after-rollback/$item"
      compare_status=$?
      if (( compare_status != 0 )); then echo "ROLLBACK_ERROR: database state mismatch: $item" >&2; emergency=1; fi
    done
  fi
  for service in api worker scheduler; do
    container=$(docker compose -p "$project" -f "$COMPOSE_FILE" ps -q "$service")
    if [[ -z "$container" || "$(docker inspect "$container" --format '{{.Image}}')" != "$(cat "$state_dir/before/$service.image-id")" || "$(docker inspect "$container" --format '{{.State.Status}}')" != running ]]; then
      echo "ROLLBACK_ERROR: $service was not restored to its exact previous image" >&2; emergency=1
    fi
  done
  set -e
  if (( emergency != 0 )); then
    printf 'STATUS=EMERGENCY_ROLLBACK_VERIFICATION_FAILED\nEXTERNAL_SUBMISSION=false\n' >"$state_dir/emergency.status"
    echo "EMERGENCY_ROLLBACK_VERIFICATION_FAILED; external submission remains disabled; do not restore the live database automatically" >&2
    exit 90
  fi
  printf 'STATUS=ROLLBACK_VERIFIED\nORIGINAL_STATUS=%s\nEXTERNAL_SUBMISSION=false\n' "$original_status" >"$state_dir/rollback.status"
  exit "$original_status"
}
canary_prepared=false
early_canary_cleanup() {
  original_status=$?
  trap - ERR INT TERM
  set +e
  if [[ "$canary_prepared" == true ]]; then
    node scripts/production-iam-canary.mjs cleanup
    cleanup_status=$?
    node scripts/production-iam-canary.mjs verify-absence
    absence_status=$?
    if (( cleanup_status != 0 || absence_status != 0 )); then exit 91; fi
  fi
  exit "$original_status"
}
trap early_canary_cleanup ERR INT TERM
node scripts/production-iam-canary.mjs dry-run
node scripts/production-iam-canary.mjs prepare
canary_prepared=true
node scripts/verify-rollout-binding.mjs
trap - ERR INT TERM
trap rollback ERR INT TERM

docker compose -p "$project" -f "$COMPOSE_FILE" run --rm -T \
  -v "$DATABASE_URL_FILE:/run/secrets/database_url:ro" -e DATABASE_URL_FILE=/run/secrets/database_url \
  -e RELEASE_ID="$EXPECTED_COMMIT" tools deployment/apply-release-migrations.sh | tee "$state_dir/migrations.log"
docker compose -p "$project" -f "$COMPOSE_FILE" up -d --no-deps --force-recreate --wait --wait-timeout 180 api worker scheduler
for service in api worker scheduler; do
  container=$(docker compose -p "$project" -f "$COMPOSE_FILE" ps -q "$service")
  [[ -n "$container" ]] || { echo "post-cutover service absent: $service" >&2; false; }
  [[ "$(docker inspect "$container" --format '{{.Image}}')" == "sha256:${EXPECTED_RELEASE_IMAGE_ID#sha256:}" ]] || { echo "post-cutover image mismatch: $service" >&2; false; }
  [[ "$(docker inspect "$container" --format '{{.State.Status}}')" == running ]] || { echo "post-cutover service not running: $service" >&2; false; }
  [[ "$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')" == healthy ]] || { echo "post-cutover service not healthy: $service" >&2; false; }
  docker inspect "$container" --format '{{.RestartCount}}' >"$state_dir/$service.post-cutover-restarts"
done
TENDER_API_BASE="$TENDER_API_BASE" node deployment/production-live-http-gate.mjs | tee "$state_dir/live-http-gate.json"
E2E_EMAIL_FILE="$PRODUCTION_CANARY_STATE_DIR/email" \
  E2E_PASSWORD_FILE="$PRODUCTION_CANARY_STATE_DIR/password" \
  E2E_TOTP_FILE="$PRODUCTION_CANARY_STATE_DIR/totp" \
  TENDER_UI_BASE="${TENDER_UI_BASE:-/admin/ausschreibungen}" \
  TENDER_API_BASE="$TENDER_API_BASE" \
  node scripts/production-iam-browser-canary.mjs | tee "$state_dir/iam-browser-canary.json"
node scripts/production-iam-canary.mjs cleanup | tee "$state_dir/iam-canary-cleanup.json"
node scripts/production-iam-canary.mjs verify-absence | tee "$state_dir/iam-canary-absence.json"
docker compose -p "$project" -f "$COMPOSE_FILE" exec -T api npm run gate:readiness
for service in api worker scheduler; do
  container=$(docker compose -p "$project" -f "$COMPOSE_FILE" ps -q "$service")
  before_restarts=$(cat "$state_dir/$service.post-cutover-restarts")
  after_restarts=$(docker inspect "$container" --format '{{.RestartCount}}')
  [[ "$before_restarts" == "$after_restarts" ]] || { echo "post-cutover restart delta is nonzero: $service" >&2; false; }
done
trap - ERR INT TERM
printf 'STATUS=ROLLOUT_COMPLETE\nCOMMIT=%s\nTREE=%s\nIMAGE_ID=sha256:%s\nIMAGE_DIGEST=sha256:%s\nBACKUP_FILE=%s\nBACKUP_MANIFEST=%s\nEXTERNAL_SUBMISSION=false\n' \
  "$EXPECTED_COMMIT" "$EXPECTED_TREE" "${EXPECTED_RELEASE_IMAGE_ID#sha256:}" "${EXPECTED_RELEASE_IMAGE_DIGEST#sha256:}" "$backup" "$manifest" >"$state_dir/rollout.status"
echo "rollout complete for $EXPECTED_COMMIT; encrypted backup retained at $backup"
