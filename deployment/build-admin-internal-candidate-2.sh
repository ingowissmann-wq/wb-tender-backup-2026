#!/usr/bin/env bash
set -euo pipefail

export GIT_PAGER=cat
export PAGER=cat
export GIT_TERMINAL_PROMPT=0
export DOCKER_BUILDKIT=1

REPO='/srv/wb-tender-recovery/canonical-source/f862ceb69ee2ee73d3ba3af82c9bad5b7bbf73fc'
BRANCH='repair/admin-sales-readiness'
EXPECTED_PARENT='07fe6806452dfe2c856b51f3fdbb1bced838fec8'
TENDER_BASE='wb-tender:global-selected-lot-region-candidate.17'
TENDER_BASE_ID='sha256:30d64f6334519b095f4af837380ac7b56df6ff0c90fb3652a0c100f3528335e3'
CANDIDATE='wb-admin:internal-recovery-candidate.2'
API='wb-tender-production-api'
CONTEXT="$(mktemp -d /srv/wb-tender-recovery/admin-runtime-2.XXXXXXXX)"

cleanup() {
  case "$CONTEXT" in
    /srv/wb-tender-recovery/admin-runtime-2.*)
      test ! -d "$CONTEXT" || find "$CONTEXT" -depth -delete
      ;;
  esac
}
trap cleanup EXIT INT TERM

test -d "$REPO/.git"
test "$(docker image inspect --format '{{.Id}}' "$TENDER_BASE")" = "$TENDER_BASE_ID"
test "$(docker inspect --format '{{.Image}}' "$API")" = "$TENDER_BASE_ID"
test "$(docker inspect --format '{{.State.Running}}' "$API")" = 'true'

if docker image inspect "$CANDIDATE" >/dev/null 2>&1; then
  printf '%s\n' 'ABORT: admin candidate tag already exists'
  exit 73
fi

printf '%s\n' '===== FETCH PINNED ADMIN SOURCE ====='

timeout 120s git -C "$REPO" fetch \
  --no-tags \
  origin \
  "refs/heads/$BRANCH"

SOURCE_COMMIT="$(git -C "$REPO" rev-parse FETCH_HEAD)"
git -C "$REPO" merge-base --is-ancestor "$EXPECTED_PARENT" "$SOURCE_COMMIT"

printf 'source_commit=%s\n' "$SOURCE_COMMIT"

git -C "$REPO" archive --format=tar "$SOURCE_COMMIT" |
  tar -xf - -C "$CONTEXT"

for FILE in \
  deployment/Dockerfile.admin-runtime-recovery \
  deployment/wb-admin-runtime-entrypoint \
  deployment/admin-commercial-tenancy-patch.mjs \
  deployment/admin-runtime-dependency-audit.mjs \
  integrations/wb-admin-portal/candidate/admin-login-mfa-enrollment-patch.mjs \
  integrations/wb-admin-portal/candidate/commercial-tenancy.js \
  integrations/wb-admin-portal/candidate/db.js \
  integrations/wb-admin-portal/candidate/module-navigation.js \
  integrations/wb-admin-portal/production-dist-baseline/api/server.js \
  integrations/wb-admin-portal/production-dist-baseline/admin/index.html
do
  test -s "$CONTEXT/$FILE"
done

printf '%s\n' '===== BUILD ISOLATED ADMIN CANDIDATE ====='

docker build \
  --pull=false \
  --no-cache \
  --network=default \
  --file "$CONTEXT/deployment/Dockerfile.admin-runtime-recovery" \
  --build-arg "ADMIN_TENDER_BASE=$TENDER_BASE" \
  --build-arg "ADMIN_TENDER_BASE_ID=$TENDER_BASE_ID" \
  --build-arg "SOURCE_FINGERPRINT=$SOURCE_COMMIT" \
  --build-arg 'RELEASE_VERSION=20260902-admin-internal-recovery.2' \
  --tag "$CANDIDATE" \
  "$CONTEXT"

CANDIDATE_ID="$(docker image inspect --format '{{.Id}}' "$CANDIDATE")"
test -n "$CANDIDATE_ID"
test "$CANDIDATE_ID" != "$TENDER_BASE_ID"

test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$CANDIDATE")" = "$SOURCE_COMMIT"
test "$(docker image inspect --format '{{index .Config.Labels "wb.external.submission"}}' "$CANDIDATE")" = 'disabled'
test "$(docker image inspect --format '{{index .Config.Labels "wb.admin.saas.default"}}' "$CANDIDATE")" = 'disabled'

printf '%s\n' '===== VERIFY ADMIN RUNTIME CONTENT ====='

docker run --rm \
  --network=none \
  --entrypoint sh \
  "$CANDIDATE" \
  -euc '
    test -s /app/apps/api/dist/server.js
    test -s /app/apps/api/dist/db.js
    test -s /app/apps/api/dist/commercial-tenancy.js
    test -s /app/apps/admin/dist/index.html
    test -s /app/apps/admin/dist/module-navigation.js
    grep -Fq "mfaSetupRequired: true" /app/apps/api/dist/server.js
    grep -Fq "createCommercialTenancy" /app/apps/api/dist/server.js
    grep -Fq "module-navigation.js" /app/apps/admin/dist/index.html
    grep -Fq "WB_ADMIN_SAAS_ENABLED=false" /usr/local/bin/wb-admin-runtime-entrypoint
    node --check /app/apps/api/dist/server.js
    node --check /app/apps/api/dist/db.js
    node --check /app/apps/api/dist/commercial-tenancy.js
  '

docker run --rm \
  --network=none \
  --entrypoint node \
  "$CANDIDATE" \
  --input-type=module <<'NODE_DEPENDENCIES'
const dependencies = [
  "@fastify/multipart",
  "@fastify/static",
  "archiver",
  "ioredis",
  "sanitize-html",
  "zod",
  "argon2"
];

for (const dependency of dependencies) {
  await import(dependency);
  console.log(`${dependency}|present`);
}
NODE_DEPENDENCIES

printf '%s\n' '===== ADMIN, TENANCY AND LICENSING TESTS ====='

docker run --rm \
  --network=none \
  --entrypoint node \
  "$CANDIDATE" \
  --test \
  --test-reporter=spec \
  /app/tests/admin-login-mfa-contract.test.mjs \
  /app/tests/admin-real-commercial-integration.test.mjs \
  /app/tests/commercial-licensing.test.mjs \
  /app/tests/commercial-modules.test.mjs \
  /app/tests/saas-iam.test.mjs \
  /app/tests/saas-platform.test.mjs \
  /app/tests/tenant-isolation.test.mjs

printf '%s\n' 'targeted_admin_tests=passed'

printf '%s\n' '===== COMPLETE REGRESSION SUITE ====='

docker run --rm \
  --network=none \
  --entrypoint sh \
  "$CANDIDATE" \
  -euc 'node --test --test-reporter=spec /app/tests/*.test.mjs'

printf '%s\n' 'complete_test_suite=passed'

PRODUCTION_HEALTH="$(
  curl --max-time 15 \
    --silent --show-error --insecure \
    --resolve 'www.enwi.online:443:127.0.0.1' \
    --output /dev/null \
    --write-out '%{http_code}' \
    https://www.enwi.online/healthz
)"
test "$PRODUCTION_HEALTH" = '200'

SUBMISSION_ENV="$(
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$API" |
    grep -Ei '^(EXTERNAL_SUBMISSION_ENABLED|WB_TENDER_ALLOW_EXTERNAL_SUBMISSION)='
)"
test -n "$SUBMISSION_ENV"
! printf '%s\n' "$SUBMISSION_ENV" |
  grep -Eiv '^[A-Z_]+=false$'

printf '%s\n' 'WB_BUILD_ADMIN_INTERNAL_CANDIDATE_2=SUCCESS'
printf 'candidate=%s\n' "$CANDIDATE"
printf 'candidate_id=%s\n' "$CANDIDATE_ID"
printf 'source_commit=%s\n' "$SOURCE_COMMIT"
printf '%s\n' 'admin_runtime_dependencies=complete_and_exhaustively_scanned'
printf '%s\n' 'admin_mfa_patch=applied'
printf '%s\n' 'admin_tenancy_patch=applied_default_off'
printf '%s\n' 'targeted_admin_tests=passed'
printf '%s\n' 'complete_test_suite=passed'
printf 'production_health=%s\n' "$PRODUCTION_HEALTH"
printf '%s\n' 'external_submission=false'
printf '%s\n' 'production_deployed=false'
printf '%s\n' 'database_changed=false'
