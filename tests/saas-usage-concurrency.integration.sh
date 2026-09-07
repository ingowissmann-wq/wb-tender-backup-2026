#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${WB_TENDER_ROLLOUT_ISOLATED_TEST:-false}" == true ]]
url=$(cat "$DATABASE_URL_FILE")
temporary=$(mktemp -d /tmp/wb-usage-race.XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT
candidate=$(psql "$url" -Atc 'SELECT gen_random_uuid()')
# This unique tenant exists only in the disposable regression database.
psql "$url" -v ON_ERROR_STOP=1 -v candidate="$candidate" <<'SQL' >/dev/null
INSERT INTO saas.tenants(id,status) VALUES(:'candidate','ACTIVE');
INSERT INTO saas.subscriptions(tenant_id,status,plan_code,current_period_ends_at) VALUES(:'candidate','ACTIVE','NORMAL',now()+interval '1 month');
SELECT set_config('app.tenant_id',:'candidate',false);
INSERT INTO tenant_portal.tender_workspaces(id,tenant_id) SELECT gen_random_uuid(),:'candidate' FROM generate_series(1,11);
INSERT INTO tenant_portal.jobs(id,tenant_id,module_key,status,payload)
SELECT gen_random_uuid(),tenant_id,'tender_autopilot','RUNNING',jsonb_build_object('workspaceId',id) FROM tenant_portal.tender_workspaces WHERE tenant_id=:'candidate' ORDER BY id LIMIT 9;
SQL
psql "$url" -v ON_ERROR_STOP=1 -v candidate="$candidate" >"$temporary/first.log" 2>&1 <<SQL &
BEGIN;
SELECT set_config('app.tenant_id',:'candidate',true);
INSERT INTO tenant_portal.jobs(id,tenant_id,module_key,status,payload)
SELECT gen_random_uuid(),tenant_id,'tender_autopilot','RUNNING',jsonb_build_object('workspaceId',id) FROM tenant_portal.tender_workspaces WHERE tenant_id=:'candidate' ORDER BY id OFFSET 9 LIMIT 1;
\! touch "$temporary/first-inserted"
SELECT pg_sleep(1);
COMMIT;
SQL
first=$!
for attempt in {1..100}; do [[ -f "$temporary/first-inserted" ]] && break; sleep .02; done
[[ -f "$temporary/first-inserted" ]]
if psql "$url" -v ON_ERROR_STOP=1 -v candidate="$candidate" >"$temporary/second.log" 2>&1 <<'SQL'
BEGIN;
SELECT set_config('app.tenant_id',:'candidate',true);
INSERT INTO tenant_portal.jobs(id,tenant_id,module_key,status,payload)
SELECT gen_random_uuid(),tenant_id,'tender_autopilot','RUNNING',jsonb_build_object('workspaceId',id) FROM tenant_portal.tender_workspaces WHERE tenant_id=:'candidate' ORDER BY id OFFSET 10 LIMIT 1;
COMMIT;
SQL
then echo 'Concurrent automation quota exceeded'; exit 1; fi
wait "$first"
grep -q 'saas_monthly_tender_limit_exceeded' "$temporary/second.log"
[[ "$(psql "$url" -Atv candidate="$candidate" <<'SQL'
SELECT count(*) FROM saas.automation_usage WHERE tenant_id=:'candidate';
SQL
)" == 10 ]]
# Remove only this test's marked, isolated data before the rollback comparison.
psql "$url" -v ON_ERROR_STOP=1 -v candidate="$candidate" <<'SQL' >/dev/null
BEGIN;
DELETE FROM saas.automation_usage WHERE tenant_id=:'candidate';
DELETE FROM tenant_portal.jobs WHERE tenant_id=:'candidate';
DELETE FROM tenant_portal.tender_workspaces WHERE tenant_id=:'candidate';
DELETE FROM saas.subscriptions WHERE tenant_id=:'candidate';
DELETE FROM saas.tenants WHERE id=:'candidate';
COMMIT;
SQL
printf 'AUTOMATION_CONCURRENCY=PASS\n'
