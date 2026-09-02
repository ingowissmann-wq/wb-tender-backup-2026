#!/usr/bin/env bash
set -eEuo pipefail
export GIT_PAGER=cat PAGER=cat GIT_TERMINAL_PROMPT=0

REPO='/srv/wb-tender-recovery/canonical-source/f862ceb69ee2ee73d3ba3af82c9bad5b7bbf73fc'
BRANCH='repair/global-exact-lot-region-binding'
SOURCE_COMMIT='c94c5382742db1a01b7fc3bf8cc0265d2619b838'
BASE_IMAGE='wb-tender:global-selected-lot-region-candidate.14'
BASE_ID='sha256:c89fe70f16e5bb0ba68b33337ed52794abf5bb99db33dea98c6f309647f20d1b'
CANDIDATE='wb-tender:global-selected-lot-region-candidate.15'
API='wb-tender-production-api'
PRODUCTION_ID='sha256:b2eb0fc53af146ed6df2c675ecf3dbf084196d539f01c47406fec441699cd21f'
CONTEXT="$(mktemp -d /srv/wb-tender-recovery/region-candidate-15.XXXXXXXX)"

cleanup(){
  case "$CONTEXT" in
    /srv/wb-tender-recovery/region-candidate-15.*)
      test ! -d "$CONTEXT" || find "$CONTEXT" -depth -delete
      ;;
  esac
}
trap cleanup EXIT INT TERM

printf '%s\n' 'WB_BUILD_TEST_GLOBAL_REGION_CANDIDATE_15=STARTED'
test -d "$REPO/.git"
test "$(docker image inspect --format '{{.Id}}' "$BASE_IMAGE")" = "$BASE_ID"
test "$(docker inspect --format '{{.Image}}' "$API")" = "$PRODUCTION_ID"
test "$(docker inspect --format '{{.State.Running}}' "$API")" = 'true'

printf '%s\n' '===== FETCH PINNED SOURCE ====='
timeout 180s git -C "$REPO" fetch --no-tags origin \
  "refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
git -C "$REPO" cat-file -e "$SOURCE_COMMIT^{commit}"
git -C "$REPO" merge-base --is-ancestor "$SOURCE_COMMIT" "refs/remotes/origin/$BRANCH"
git -C "$REPO" archive --format=tar "$SOURCE_COMMIT" | tar -xf - -C "$CONTEXT"
printf 'source_commit=%s\n' "$SOURCE_COMMIT"

printf '%s\n' '===== VERIFY RUNTIME FIX CONTRACT ====='
grep -Fq "runKind:\"SELECTED_LOT_REGION_REPAIR\"" "$CONTEXT/platform/region-recalculation-worker.mjs"
grep -Fq "'SELECTED_LOT_REGION_REPAIR'" "$CONTEXT/migrations/162_selected_lot_region_invariant.sql"
grep -Fq 'inbox_pipeline_runs_run_kind_check' "$CONTEXT/migrations/162_selected_lot_region_invariant.sql"
grep -Fq 'inbox_pipeline_runs_run_kind_check' "$CONTEXT/migrations/162_selected_lot_region_invariant.down.sql"
if grep -Fq "'SELECTED_LOT_REGION_REPAIR'" "$CONTEXT/migrations/162_selected_lot_region_invariant.down.sql"; then
  printf '%s\n' 'ABORT: rollback constraint must not retain repair run kind'
  exit 41
fi
printf '%s\n' 'constraint_regression_contract=PASS'

if docker image inspect "$CANDIDATE" >/dev/null 2>&1; then
  test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$CANDIDATE")" = "$SOURCE_COMMIT"
  printf '%s\n' 'candidate_build=reused_verified_tag'
else
  printf '%s\n' '===== BUILD CANDIDATE 15 ====='
  timeout 900s docker build --progress=plain --pull=false --no-cache --network=none \
    --file "$CONTEXT/Dockerfile.release" \
    --build-arg "RUNTIME_IMAGE=$BASE_IMAGE" \
    --build-arg "RUNTIME_IMAGE_ID=$BASE_ID" \
    --build-arg 'RELEASE_VERSION=20260902-global-selected-lot-region.15' \
    --build-arg "SOURCE_FINGERPRINT=$SOURCE_COMMIT" \
    --tag "$CANDIDATE" "$CONTEXT"
fi

CANDIDATE_ID="$(docker image inspect --format '{{.Id}}' "$CANDIDATE")"
test -n "$CANDIDATE_ID"
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$CANDIDATE")" = "$SOURCE_COMMIT"

printf '%s\n' '===== TARGETED REGRESSION TESTS ====='
timeout 300s docker run --rm --network=none --entrypoint node "$CANDIDATE" \
  --test --test-reporter=spec \
  /app/tests/global-exact-lot-region-binding.test.mjs \
  /app/tests/inbox-pipeline.test.mjs \
  /app/tests/structured-region-atomic-approval.test.mjs
printf '%s\n' 'targeted_tests=PASS'

printf '%s\n' '===== COMPLETE TEST SUITE ====='
timeout 900s docker run --rm --network=none --entrypoint sh "$CANDIDATE" \
  -ec 'node --test --test-reporter=spec /app/tests/*.test.mjs'
printf '%s\n' 'complete_test_suite=PASS'

PRODUCTION_HEALTH="$(curl --silent --show-error --insecure \
  --resolve 'www.enwi.online:443:127.0.0.1' \
  --output /dev/null --write-out '%{http_code}' \
  https://www.enwi.online/healthz)"
test "$PRODUCTION_HEALTH" = '200'
test "$(docker inspect --format '{{.Image}}' "$API")" = "$PRODUCTION_ID"

SUBMISSION_ENV="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$API" |
  grep -Ei '^(EXTERNAL_SUBMISSION_ENABLED|PORTAL_SUBMISSION_ENABLED|SUBMISSION_ENABLED)=')"
test -n "$SUBMISSION_ENV"
! printf '%s\n' "$SUBMISSION_ENV" | grep -Eiv '^[A-Z_]+=false$'

printf '%s\n' 'WB_BUILD_TEST_GLOBAL_REGION_CANDIDATE_15=SUCCESS'
printf 'candidate=%s\n' "$CANDIDATE"
printf 'candidate_id=%s\n' "$CANDIDATE_ID"
printf 'source_commit=%s\n' "$SOURCE_COMMIT"
printf '%s\n' 'test_failures=0'
printf 'production_health=%s\n' "$PRODUCTION_HEALTH"
printf '%s\n' 'external_submission=false'
printf '%s\n' 'production_changed=false'
printf '%s\n' 'database_changed=false'
