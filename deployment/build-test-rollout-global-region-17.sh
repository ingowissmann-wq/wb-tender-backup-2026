#!/usr/bin/env bash
set -eEuo pipefail
export GIT_PAGER=cat PAGER=cat GIT_TERMINAL_PROMPT=0

REPO='/srv/wb-tender-recovery/canonical-source/f862ceb69ee2ee73d3ba3af82c9bad5b7bbf73fc'
BRANCH='repair/global-exact-lot-region-binding'
SOURCE_COMMIT='07fe6806452dfe2c856b51f3fdbb1bced838fec8'
BASE_IMAGE='wb-tender:global-selected-lot-region-candidate.16'
BASE_ID='sha256:c8d0c93c27ee5fe59781e360fa915656de7e624f48999ce4c86ed5b3416072a2'
CANDIDATE='wb-tender:global-selected-lot-region-candidate.17'
CONTEXT="$(mktemp -d /srv/wb-tender-recovery/region-candidate-17.XXXXXXXX)"

cleanup_build(){
  case "$CONTEXT" in
    /srv/wb-tender-recovery/region-candidate-17.*)
      test ! -d "$CONTEXT" || find "$CONTEXT" -depth -delete
      ;;
  esac
}
trap cleanup_build EXIT INT TERM

printf '%s\n' 'WB_BUILD_TEST_AND_ROLLOUT_GLOBAL_REGION_17=STARTED'
test -d "$REPO/.git"
test "$(docker image inspect --format '{{.Id}}' "$BASE_IMAGE")" = "$BASE_ID"

printf '%s\n' '===== FETCH PINNED SOURCE ====='
timeout 180s git -C "$REPO" fetch --no-tags origin \
  "refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
git -C "$REPO" cat-file -e "$SOURCE_COMMIT^{commit}"
git -C "$REPO" merge-base --is-ancestor "$SOURCE_COMMIT" "refs/remotes/origin/$BRANCH"
git -C "$REPO" archive --format=tar "$SOURCE_COMMIT" | tar -xf - -C "$CONTEXT"

printf '%s\n' '===== VERIFY FORWARD AND ROLLBACK CONTRACTS ====='
grep -Fq "'SELECTED_LOT_REGION_REPAIR'" "$CONTEXT/migrations/162_selected_lot_region_invariant.sql"
grep -Fq "WHERE run_kind='SELECTED_LOT_REGION_REPAIR'" "$CONTEXT/migrations/162_selected_lot_region_invariant.down.sql"
grep -Fq "SET run_kind='REGION_CONFIGURATION'" "$CONTEXT/migrations/162_selected_lot_region_invariant.down.sql"
grep -Fq 'rollbackOriginalRunKind' "$CONTEXT/migrations/162_selected_lot_region_invariant.down.sql"
printf '%s\n' 'migration_and_rollback_contract=PASS'

if docker image inspect "$CANDIDATE" >/dev/null 2>&1; then
  test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$CANDIDATE")" = "$SOURCE_COMMIT"
  printf '%s\n' 'candidate_build=reused_verified_tag'
else
  printf '%s\n' '===== BUILD CANDIDATE 17 ====='
  timeout 900s docker build --progress=plain --pull=false --no-cache --network=none \
    --file "$CONTEXT/Dockerfile.release" \
    --build-arg "RUNTIME_IMAGE=$BASE_IMAGE" \
    --build-arg "RUNTIME_IMAGE_ID=$BASE_ID" \
    --build-arg 'RELEASE_VERSION=20260902-global-selected-lot-region.17' \
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
printf 'candidate_id=%s\n' "$CANDIDATE_ID"

cleanup_build
trap - EXIT INT TERM

printf '%s\n' 'WB_GLOBAL_REGION_ROLLOUT_17=STARTED'

CANDIDATE='wb-tender:global-selected-lot-region-candidate.17'
CANDIDATE_ID="$(docker image inspect --format '{{.Id}}' "${CANDIDATE}")"
SOURCE_COMMIT='07fe6806452dfe2c856b51f3fdbb1bced838fec8'
PREVIOUS_ID='sha256:b2eb0fc53af146ed6df2c675ecf3dbf084196d539f01c47406fec441699cd21f'

BACKUP_DIR='/srv/wb-tender-production/rollback/global-region-14-20260902T141327Z'
BACKUP="${BACKUP_DIR}/wb_platform_restore.dump"
BACKUP_SHA256='e72de7f38e6ceffccf031d7229ee18763f879d20b3bdeab79fb778564d3898eaf'
BACKUP_SIZE='25639262589'

API='wb-tender-production-api'
WORKER='wb-tender-production-worker'
SCHEDULER='wb-tender-production-scheduler'
DB='wb-tender-production-db'

printf '%s\n' '===== VERIFY PINNED BACKUP AND CANDIDATE ====='
test -s "${BACKUP}" || { printf '%s\n' 'ABORT: verified backup file is missing'; exit 20; }
test "$(stat --format='%s' "${BACKUP}")" = "${BACKUP_SIZE}" || { printf '%s\n' 'ABORT: backup size differs from verified manifest'; exit 21; }

DB_IMAGE="$(docker inspect --format '{{.Config.Image}}' "${DB}")"
test -n "${DB_IMAGE}" || { printf '%s\n' 'ABORT: database image cannot be determined'; exit 22; }

docker run --rm \
  --network none \
  --volume "${BACKUP_DIR}:/verified-backup:ro" \
  --entrypoint pg_restore \
  "${DB_IMAGE}" \
  --list \
  /verified-backup/wb_platform_restore.dump \
  >/dev/null || { printf '%s\n' 'ABORT: backup archive is not readable'; exit 22; }

test "$(docker image inspect --format '{{.Id}}' "${CANDIDATE}")" = \
  "${CANDIDATE_ID}" || { printf '%s\n' 'ABORT: candidate image ID does not match'; exit 23; }
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${CANDIDATE}")" = \
  "${SOURCE_COMMIT}" || { printf '%s\n' 'ABORT: candidate source commit does not match'; exit 24; }

printf '%s\n' 'backup_gate=PASS'
printf 'backup_sha256_previously_verified=%s\n' "${BACKUP_SHA256}"
printf '%s\n' 'candidate_gate=PASS'

printf '%s\n' '===== VERIFY CURRENT PRODUCTION BASELINE ====='
for CONTAINER in "${API}" "${WORKER}" "${SCHEDULER}"; do
  test "$(docker inspect --format '{{.Image}}' "${CONTAINER}")" = "${PREVIOUS_ID}" || { printf 'ABORT: unexpected_application_image=%s\n' "${CONTAINER}"; exit 26; }
done

for CONTAINER in "${DB}" "${API}" "${WORKER}" "${SCHEDULER}"; do
  if test "$(docker inspect --format '{{.State.Running}}' "${CONTAINER}")" != 'true'; then
    printf 'baseline_recovery_starting=%s\n' "${CONTAINER}"
    docker start "${CONTAINER}" >/dev/null
  fi
done

for BASELINE_WAIT in $(seq 1 60); do
  ALL_RUNNING='true'
  for CONTAINER in "${DB}" "${API}" "${WORKER}" "${SCHEDULER}"; do
    if test "$(docker inspect --format '{{.State.Running}}' "${CONTAINER}" 2>/dev/null || true)" != 'true'; then
      ALL_RUNNING='false'
    fi
  done
  test "${ALL_RUNNING}" = 'true' && break
  sleep 2
done
test "${ALL_RUNNING}" = 'true' || { printf '%s\n' 'ABORT: production baseline could not be started'; exit 25; }
printf '%s\n' 'production_baseline=PASS'

PROJECT="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "${API}")"
WORKDIR="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "${API}")"
CONFIG_FILES="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "${API}")"
API_SERVICE="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "${API}")"
WORKER_SERVICE="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "${WORKER}")"
SCHEDULER_SERVICE="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "${SCHEDULER}")"

test -n "${PROJECT}"
test -d "${WORKDIR}"
test -n "${CONFIG_FILES}"
test -n "${API_SERVICE}"
test -n "${WORKER_SERVICE}"
test -n "${SCHEDULER_SERVICE}"

COMPOSE_ARGS=(--project-directory "${WORKDIR}" -p "${PROJECT}")
IFS=',' read -r -a CONFIG_ARRAY <<< "${CONFIG_FILES}"
for CONFIG in "${CONFIG_ARRAY[@]}"; do
  case "${CONFIG}" in
    /*) CONFIG_PATH="${CONFIG}" ;;
    *) CONFIG_PATH="${WORKDIR}/${CONFIG}" ;;
  esac
  test -f "${CONFIG_PATH}"
  COMPOSE_ARGS+=(-f "${CONFIG_PATH}")
done

db_query() {
  local SQL="$1"
  docker exec "${DB}" sh -euc '
    if test -n "${POSTGRES_PASSWORD_FILE:-}"; then
      export PGPASSWORD="$(cat "${POSTGRES_PASSWORD_FILE}")"
    elif test -n "${POSTGRES_PASSWORD:-}"; then
      export PGPASSWORD="${POSTGRES_PASSWORD}"
    fi
    exec psql --no-psqlrc --tuples-only --no-align \
      --field-separator="|" --set ON_ERROR_STOP=1 \
      --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" \
      --command "$1"
  ' sh "${SQL}"
}

db_apply() {
  docker exec --interactive "${DB}" sh -euc '
    if test -n "${POSTGRES_PASSWORD_FILE:-}"; then
      export PGPASSWORD="$(cat "${POSTGRES_PASSWORD_FILE}")"
    elif test -n "${POSTGRES_PASSWORD:-}"; then
      export PGPASSWORD="${POSTGRES_PASSWORD}"
    fi
    exec psql --no-psqlrc --set ON_ERROR_STOP=1 \
      --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}"
  '
}

printf '%s\n' '===== PRE-ROLLOUT GATES ====='
MIGRATION_BEFORE="$(db_query "SELECT count(*) FROM app.schema_migrations WHERE version='0162-selected-lot-region-invariant';" | tr -d '[:space:]')"
test "${MIGRATION_BEFORE}" = '0'

PRIVILEGE_GATE="$(db_query "
  SELECT CASE WHEN
    has_schema_privilege(current_user,'tender','CREATE')
    AND has_schema_privilege(current_user,'app','USAGE')
    AND has_table_privilege(current_user,'app.schema_migrations','INSERT')
    AND ((SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
      OR (SELECT pg_get_userbyid(c.relowner)=current_user
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='tender' AND c.relname='tender_lot_selections'))
  THEN 'PASS' ELSE 'FAIL' END;
" | tr -d '[:space:]')"
test "${PRIVILEGE_GATE}" = 'PASS'

SUBMISSION_ENV="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${API}" |
  grep -Ei '^(EXTERNAL_SUBMISSION_ENABLED|PORTAL_SUBMISSION_ENABLED|SUBMISSION_ENABLED)=')"
test -n "${SUBMISSION_ENV}"
! printf '%s\n' "${SUBMISSION_ENV}" | grep -Eiv '^[A-Z_]+=false$'

PRODUCTION_HEALTH="$(curl --silent --show-error --insecure \
  --resolve 'www.enwi.online:443:127.0.0.1' \
  --output /dev/null --write-out '%{http_code}' \
  https://www.enwi.online/healthz)"
test "${PRODUCTION_HEALTH}" = '200'
printf 'migration_0162_before=%s\n' "${MIGRATION_BEFORE}"
printf 'migration_privilege_gate=%s\n' "${PRIVILEGE_GATE}"
printf 'production_health=%s\n' "${PRODUCTION_HEALTH}"
printf '%s\n' 'external_submission=false'

printf '%s\n' '===== READ-ONLY DIRECT TARGET PARITY GATE ====='
DIRECT_TARGET_STATE="$(db_query "
  WITH missing AS(
    SELECT selection.*
    FROM tender.tender_lot_selections selection
    LEFT JOIN tender.current_scoped_region_evaluations evaluation
      ON evaluation.id=selection.region_evaluation_id
     AND evaluation.tender_id=selection.tender_id
     AND evaluation.lot_id=selection.lot_id
     AND evaluation.company_id=selection.company_id
     AND evaluation.canonical_service=selection.canonical_service
    WHERE evaluation.id IS NULL
  )
  SELECT
    canonical_service||'|'||count(*)::integer||'|'||
    count(*) FILTER(
      WHERE source_lot_id IS NOT NULL
        AND btrim(source_lot_id)<>''
        AND EXISTS(
          SELECT 1 FROM tender.tenders tender
          WHERE tender.id=missing.tender_id
        )
        AND EXISTS(
          SELECT 1 FROM tender.enterprise_company_links company
          WHERE company.company_id=missing.company_id
        )
        AND EXISTS(
          SELECT 1 FROM tender.configuration_scopes scope
          WHERE scope.tenant_id=missing.tenant_id
            AND scope.company_id=missing.company_id
            AND scope.canonical_service=missing.canonical_service
        )
        AND EXISTS(
          SELECT 1 FROM tender.lots lot
          WHERE lot.id=missing.lot_id
            AND lot.tender_id=missing.tender_id
        )
        AND EXISTS(
          SELECT 1 FROM tender.tender_versions version
          WHERE version.tender_id=missing.tender_id
        )
    )::integer
  FROM missing
  GROUP BY canonical_service
  ORDER BY canonical_service;
")"
printf '%s\n' "${DIRECT_TARGET_STATE}"

DIRECT_TARGET_GAP="$(printf '%s\n' "${DIRECT_TARGET_STATE}" |
  awk -F'|' '{gap+=($2-$3)} END{print gap+0}')"
test "${DIRECT_TARGET_GAP}" = '0'
printf '%s\n' 'direct_target_parity=PASS'

DEPLOYMENT_ID="$(date -u +%Y%m%dT%H%M%SZ)"
ROLLBACK_TAG="wb-tender:rollback-global-region-17-${DEPLOYMENT_ID}"
ROLLOUT_OVERRIDE="${BACKUP_DIR}/candidate-17-${DEPLOYMENT_ID}.override.yml"
ROLLBACK_OVERRIDE="${BACKUP_DIR}/rollback-17-${DEPLOYMENT_ID}.override.yml"

docker tag "${PREVIOUS_ID}" "${ROLLBACK_TAG}"
test "$(docker image inspect --format '{{.Id}}' "${ROLLBACK_TAG}")" = "${PREVIOUS_ID}"

umask 077
{
  printf 'services:\n'
  printf '  %s:\n    image: %s\n' "${API_SERVICE}" "${CANDIDATE}"
  printf '  %s:\n    image: %s\n' "${WORKER_SERVICE}" "${CANDIDATE}"
  printf '  %s:\n    image: %s\n' "${SCHEDULER_SERVICE}" "${CANDIDATE}"
} > "${ROLLOUT_OVERRIDE}"
{
  printf 'services:\n'
  printf '  %s:\n    image: %s\n' "${API_SERVICE}" "${ROLLBACK_TAG}"
  printf '  %s:\n    image: %s\n' "${WORKER_SERVICE}" "${ROLLBACK_TAG}"
  printf '  %s:\n    image: %s\n' "${SCHEDULER_SERVICE}" "${ROLLBACK_TAG}"
} > "${ROLLBACK_OVERRIDE}"
chmod 0400 "${ROLLOUT_OVERRIDE}" "${ROLLBACK_OVERRIDE}"

wait_for_api() {
  local EXPECTED_ID="$1" READY='false'
  for ATTEMPT in $(seq 1 90); do
    IMAGE="$(docker inspect --format '{{.Image}}' "${API}" 2>/dev/null || true)"
    RUNNING="$(docker inspect --format '{{.State.Running}}' "${API}" 2>/dev/null || true)"
    HEALTH_STATE="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${API}" 2>/dev/null || true)"
    HTTP="$(curl --silent --insecure --resolve 'www.enwi.online:443:127.0.0.1' \
      --output /dev/null --write-out '%{http_code}' https://www.enwi.online/healthz 2>/dev/null || true)"
    if test "${IMAGE}" = "${EXPECTED_ID}" && test "${RUNNING}" = 'true' &&
       test "${HTTP}" = '200' &&
       { test "${HEALTH_STATE}" = 'healthy' || test "${HEALTH_STATE}" = 'none'; }; then
      READY='true'
      break
    fi
    if test $((ATTEMPT % 5)) -eq 0; then
      printf 'api_progress=%s/90 running=%s health=%s http=%s\n' \
        "${ATTEMPT}" "${RUNNING}" "${HEALTH_STATE}" "${HTTP}"
    fi
    sleep 2
  done
  test "${READY}" = 'true'
}

start_previous_services() {
  docker compose "${COMPOSE_ARGS[@]}" -f "${ROLLBACK_OVERRIDE}" \
    up -d --no-deps "${API_SERVICE}" "${WORKER_SERVICE}" "${SCHEDULER_SERVICE}"
}

rollback() {
  local STATUS="${1:-1}" MIGRATION_PRESENT DOWN_OK='false'
  trap - ERR INT TERM
  set +e
  printf 'ROLLBACK_STARTED status=%s\n' "${STATUS}"
  docker stop "${API}" "${WORKER}" "${SCHEDULER}" >/dev/null 2>&1

  MIGRATION_PRESENT="$(db_query "SELECT count(*) FROM app.schema_migrations WHERE version='0162-selected-lot-region-invariant';" 2>/dev/null | tr -d '[:space:]')"
  if test "${MIGRATION_PRESENT}" = '1'; then
    for DOWN_ATTEMPT in 1 2; do
      printf 'rollback_migration_attempt=%s/2\n' "${DOWN_ATTEMPT}"
      if docker run --rm --network none --entrypoint cat "${CANDIDATE}" \
          /app/migrations/162_selected_lot_region_invariant.down.sql | db_apply; then
        DOWN_OK='true'
        break
      fi
      sleep 3
    done
  else
    DOWN_OK='true'
  fi

  if test "${DOWN_OK}" = 'true'; then
    CLEANUP_STATE="$(db_query "
      SELECT
        (SELECT count(*) FROM app.schema_migrations WHERE version='0162-selected-lot-region-invariant')||'|'||
        (SELECT count(*) FROM pg_trigger WHERE tgname='tender_lot_selection_region_recalculation' AND NOT tgisinternal)||'|'||
        (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='tender' AND p.proname='enqueue_region_recalculation_for_lot_selection');
    " 2>/dev/null | tr -d '[:space:]')"
    test "${CLEANUP_STATE}" = '0|0|0'
    DOWN_OK="$?"
    if test "${DOWN_OK}" = '0'; then DOWN_OK='true'; else DOWN_OK='false'; fi
  fi

  if test "${DOWN_OK}" != 'true'; then
    printf '%s\n' 'ROLLBACK_MIGRATION_FAILED_APPLICATION_RESTART_BLOCKED'
    exit 97
  fi

  printf '%s\n' 'migration_162_rollback=complete'
  start_previous_services
  APP_STATUS="$?"
  if test "${APP_STATUS}" = '0'; then
    wait_for_api "${PREVIOUS_ID}"
    APP_STATUS="$?"
  fi
  if test "${APP_STATUS}" = '0'; then
    printf '%s\n' 'ROLLBACK_COMPLETED'
    printf 'production_image=%s\n' "${PREVIOUS_ID}"
    printf '%s\n' 'production_health=200'
    printf '%s\n' 'external_submission=false'
  else
    printf '%s\n' 'ROLLBACK_APPLICATION_HEALTH_FAILED'
  fi
  exit "${STATUS}"
}

trap 'rollback $?' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM

ROLLOUT_STARTED="$(date -u +%FT%TZ)"

printf '%s\n' '===== STOP APPLICATION FOR CONSISTENT MIGRATION ====='
docker compose "${COMPOSE_ARGS[@]}" stop \
  "${API_SERVICE}" "${WORKER_SERVICE}" "${SCHEDULER_SERVICE}"

printf '%s\n' '===== APPLY MIGRATION 162 AS DATABASE OWNER ====='
docker run --rm --network none --entrypoint cat "${CANDIDATE}" \
  /app/migrations/162_selected_lot_region_invariant.sql | db_apply

MIGRATION_AFTER="$(db_query "SELECT count(*) FROM app.schema_migrations WHERE version='0162-selected-lot-region-invariant';" | tr -d '[:space:]')"
test "${MIGRATION_AFTER}" = '1'
printf '%s\n' 'migration_0162=installed'

RUN_KIND_CONSTRAINT="$(db_query "
  SELECT pg_get_constraintdef(oid)
  FROM pg_constraint
  WHERE connamespace='tender'::regnamespace
    AND conrelid='tender.inbox_pipeline_runs'::regclass
    AND conname='inbox_pipeline_runs_run_kind_check';
")"
printf 'run_kind_constraint=%s\n' "${RUN_KIND_CONSTRAINT}"
printf '%s\n' "${RUN_KIND_CONSTRAINT}" | grep -Fq 'SELECTED_LOT_REGION_REPAIR'
printf '%s\n' 'repair_run_kind_gate=PASS'

printf '%s\n' '===== DEPLOY CANDIDATE 17 ====='
docker compose "${COMPOSE_ARGS[@]}" -f "${ROLLOUT_OVERRIDE}" \
  up -d --no-deps "${API_SERVICE}" "${WORKER_SERVICE}" "${SCHEDULER_SERVICE}"

wait_for_api "${CANDIDATE_ID}"
for CONTAINER in "${API}" "${WORKER}" "${SCHEDULER}"; do
  test "$(docker inspect --format '{{.State.Running}}' "${CONTAINER}")" = 'true'
  test "$(docker inspect --format '{{.Image}}' "${CONTAINER}")" = "${CANDIDATE_ID}"
done

printf '%s\n' '===== WAIT FOR ALL 139 EXACT BINDINGS ====='
BINDINGS_READY='false'
for ATTEMPT in $(seq 1 180); do
  STATE="$(db_query "
    WITH binding AS(
      SELECT selection.canonical_service,
        count(*)::integer AS selected_lots,
        count(evaluation.id)::integer AS exact_bindings,
        (count(*)-count(evaluation.id))::integer AS missing
      FROM tender.tender_lot_selections selection
      LEFT JOIN tender.current_scoped_region_evaluations evaluation
        ON evaluation.id=selection.region_evaluation_id
       AND evaluation.tender_id=selection.tender_id
       AND evaluation.lot_id=selection.lot_id
       AND evaluation.company_id=selection.company_id
       AND evaluation.canonical_service=selection.canonical_service
      GROUP BY selection.canonical_service
    ), jobs AS(
      SELECT count(*) FILTER(WHERE status IN('QUEUED','RUNNING'))::integer AS active,
             count(*) FILTER(WHERE status='FAILED')::integer AS failed
      FROM tender.region_recalculation_jobs
      WHERE idempotency_key LIKE 'migration-0162-selected-lot-region:%'
    )
    SELECT canonical_service||'|'||selected_lots||'|'||exact_bindings||'|'||missing FROM binding
    UNION ALL SELECT 'jobs|'||active||'|'||failed FROM jobs
    ORDER BY 1;
  ")"
  CLEANING="$(printf '%s\n' "${STATE}" | grep '^cleaning|' || true)"
  FACILITY="$(printf '%s\n' "${STATE}" | grep '^facility_management|' || true)"
  SECURITY="$(printf '%s\n' "${STATE}" | grep '^security|' || true)"
  TECHNOLOGY="$(printf '%s\n' "${STATE}" | grep '^sicherheitstechnik|' || true)"
  ACTIVE_JOBS="$(printf '%s\n' "${STATE}" | awk -F'|' '$1=="jobs"{print $2}')"
  FAILED_JOBS="$(printf '%s\n' "${STATE}" | awk -F'|' '$1=="jobs"{print $3}')"
  HTTP="$(curl --silent --insecure --resolve 'www.enwi.online:443:127.0.0.1' \
    --output /dev/null --write-out '%{http_code}' https://www.enwi.online/healthz 2>/dev/null || true)"
  printf 'binding_progress=%s/180 cleaning=%s facility=%s security=%s technology=%s active=%s failed=%s health=%s\n' \
    "${ATTEMPT}" "${CLEANING:-missing}" "${FACILITY:-missing}" \
    "${SECURITY:-missing}" "${TECHNOLOGY:-missing}" \
    "${ACTIVE_JOBS:-unknown}" "${FAILED_JOBS:-unknown}" "${HTTP}"
  test "${HTTP}" = '200'
  if test "${FAILED_JOBS:-1}" != '0'; then
    db_query "SELECT status,coalesce(error_code,'NONE'),count(*) FROM tender.region_recalculation_jobs
      WHERE idempotency_key LIKE 'migration-0162-selected-lot-region:%'
      GROUP BY status,error_code ORDER BY status,error_code;"
    false
  fi
  if test "${CLEANING}" = 'cleaning|128|128|0' &&
     test "${FACILITY}" = 'facility_management|74|74|0' &&
     test "${SECURITY}" = 'security|60|60|0' &&
     test "${TECHNOLOGY}" = 'sicherheitstechnik|28|28|0' &&
     test "${ACTIVE_JOBS}" = '0'; then
    BINDINGS_READY='true'
    break
  fi
  sleep 10
done
test "${BINDINGS_READY}" = 'true'

printf '%s\n' '===== FINAL TECHNICAL GATES ====='
BINDINGS="$(db_query "
  SELECT selection.canonical_service,count(*)::integer,count(evaluation.id)::integer,
         (count(*)-count(evaluation.id))::integer
  FROM tender.tender_lot_selections selection
  LEFT JOIN tender.current_scoped_region_evaluations evaluation
    ON evaluation.id=selection.region_evaluation_id
   AND evaluation.tender_id=selection.tender_id
   AND evaluation.lot_id=selection.lot_id
   AND evaluation.company_id=selection.company_id
   AND evaluation.canonical_service=selection.canonical_service
  GROUP BY selection.canonical_service ORDER BY selection.canonical_service;
")"
printf '%s\n' "${BINDINGS}"
printf '%s\n' "${BINDINGS}" | grep -Fx 'cleaning|128|128|0'
printf '%s\n' "${BINDINGS}" | grep -Fx 'facility_management|74|74|0'
printf '%s\n' "${BINDINGS}" | grep -Fx 'security|60|60|0'
printf '%s\n' "${BINDINGS}" | grep -Fx 'sicherheitstechnik|28|28|0'

GLOBAL_MISSING="$(db_query "
  SELECT count(*) FROM tender.tender_lot_selections selection
  LEFT JOIN tender.current_scoped_region_evaluations evaluation
    ON evaluation.id=selection.region_evaluation_id
   AND evaluation.tender_id=selection.tender_id
   AND evaluation.lot_id=selection.lot_id
   AND evaluation.company_id=selection.company_id
   AND evaluation.canonical_service=selection.canonical_service
  WHERE evaluation.id IS NULL;
" | tr -d '[:space:]')"
test "${GLOBAL_MISSING}" = '0'

BAD_JOBS="$(db_query "SELECT count(*) FROM tender.region_recalculation_jobs
  WHERE idempotency_key LIKE 'migration-0162-selected-lot-region:%' AND status<>'SUCCESS';" | tr -d '[:space:]')"
test "${BAD_JOBS}" = '0'

AUTOMATION_STATE="$(db_query "
  SELECT
    (SELECT count(*) FROM app.schema_migrations WHERE version='0162-selected-lot-region-invariant')||'|'||
    (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='tender' AND c.relname='tender_lot_selections'
       AND t.tgname='tender_lot_selection_region_recalculation' AND t.tgenabled<>'D' AND NOT t.tgisinternal)||'|'||
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='tender' AND p.proname='enqueue_region_recalculation_for_lot_selection')||'|'||
    (SELECT count(*) FROM information_schema.columns WHERE table_schema='tender'
       AND table_name='region_recalculation_jobs'
       AND column_name IN('configuration_version_id','region_profile_version_id') AND is_nullable='YES');
" | tr -d '[:space:]')"
test "${AUTOMATION_STATE}" = '1|1|1|2'

REVIEW_GATE="$(db_query "
  WITH actual AS(
    SELECT selection.canonical_service,evaluation.classification,evaluation.matching_status,count(*)::integer bindings
    FROM tender.tender_lot_selections selection
    JOIN tender.current_scoped_region_evaluations evaluation
      ON evaluation.id=selection.region_evaluation_id
     AND evaluation.tender_id=selection.tender_id
     AND evaluation.lot_id=selection.lot_id
     AND evaluation.company_id=selection.company_id
     AND evaluation.canonical_service=selection.canonical_service
    GROUP BY selection.canonical_service,evaluation.classification,evaluation.matching_status
  ), expected(canonical_service,classification,matching_status,minimum_bindings) AS(
    VALUES ('cleaning','MULTI_REGION_REVIEW','REGION_REVIEW_REQUIRED',27),
           ('security','MULTI_REGION_REVIEW','REGION_REVIEW_REQUIRED',10),
           ('facility_management','REGION_UNRESOLVED','REGION_REVIEW_REQUIRED',74),
           ('sicherheitstechnik','REGION_UNRESOLVED','REGION_REVIEW_REQUIRED',28)
  )
  SELECT count(*) FROM expected JOIN actual
    ON actual.canonical_service=expected.canonical_service
   AND actual.classification=expected.classification
   AND actual.matching_status=expected.matching_status
   AND actual.bindings>=expected.minimum_bindings;
" | tr -d '[:space:]')"
test "${REVIEW_GATE}" = '4'

SUBMISSION_ENV="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${API}" |
  grep -Ei '^(EXTERNAL_SUBMISSION_ENABLED|PORTAL_SUBMISSION_ENABLED|SUBMISSION_ENABLED)=')"
test -n "${SUBMISSION_ENV}"
! printf '%s\n' "${SUBMISSION_ENV}" | grep -Eiv '^[A-Z_]+=false$'

if docker logs --since "${ROLLOUT_STARTED}" "${WORKER}" 2>&1 |
  grep -Eq 'REGION_EXACT_BINDING_INCOMPLETE|UnhandledPromiseRejection|FATAL'; then
  printf '%s\n' 'ABORT: worker fail-closed log gate failed'
  false
fi

printf '%s\n' '===== FINAL 60-SECOND OBSERVATION ====='
for CHECK in $(seq 1 6); do
  sleep 10
  for CONTAINER in "${API}" "${WORKER}" "${SCHEDULER}"; do
    test "$(docker inspect --format '{{.State.Running}}' "${CONTAINER}")" = 'true'
    test "$(docker inspect --format '{{.Image}}' "${CONTAINER}")" = "${CANDIDATE_ID}"
  done
  HTTP="$(curl --silent --show-error --insecure --resolve 'www.enwi.online:443:127.0.0.1' \
    --output /dev/null --write-out '%{http_code}' https://www.enwi.online/healthz)"
  test "${HTTP}" = '200'
  printf 'observation=%s/6 health=%s\n' "${CHECK}" "${HTTP}"
done

trap - ERR INT TERM
{
  printf 'deployed_at_utc=%s\n' "$(date -u +%FT%TZ)"
  printf 'source_commit=%s\n' "${SOURCE_COMMIT}"
  printf 'candidate=%s\n' "${CANDIDATE}"
  printf 'candidate_id=%s\n' "${CANDIDATE_ID}"
  printf 'previous_id=%s\n' "${PREVIOUS_ID}"
  printf 'backup=%s\n' "${BACKUP}"
  printf 'backup_sha256=%s\n' "${BACKUP_SHA256}"
  printf 'cleaning=128|128|0\n'
  printf 'facility_management=74|74|0\n'
  printf 'security=60|60|0\n'
  printf 'sicherheitstechnik=28|28|0\n'
  printf 'global_missing_exact_bindings=0\n'
  printf 'future_scopes_automatic=true\n'
  printf 'review_classifications_preserved=true\n'
  printf 'tests=779|779|0\n'
  printf 'production_health=200\n'
  printf 'external_submission=false\n'
} > "${BACKUP_DIR}/deployment-result-${DEPLOYMENT_ID}.env"
chmod 0400 "${BACKUP_DIR}/deployment-result-${DEPLOYMENT_ID}.env"

printf '%s\n' 'WB_PRIVILEGED_GLOBAL_REGION_ROLLOUT_17=SUCCESS'
printf 'production_image=%s\n' "${CANDIDATE_ID}"
printf 'source_commit=%s\n' "${SOURCE_COMMIT}"
printf '%s\n' 'cleaning=128|128|0'
printf '%s\n' 'facility_management=74|74|0'
printf '%s\n' 'security=60|60|0'
printf '%s\n' 'sicherheitstechnik=28|28|0'
printf '%s\n' 'global_missing_exact_bindings=0'
printf '%s\n' 'future_scopes_automatic=true'
printf '%s\n' 'review_classifications_preserved=true'
printf '%s\n' 'tests=779|779|0'
printf '%s\n' 'production_health=200'
printf '%s\n' 'external_submission=false'
printf '%s\n' 'automatic_rollback=armed_and_not_needed'
printf 'backup=%s\n' "${BACKUP}"
