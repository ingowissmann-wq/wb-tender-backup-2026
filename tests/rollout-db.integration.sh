#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ "${WB_TENDER_ROLLOUT_ISOLATED_TEST:-false}" == true ]] || { echo "isolated rollout database test marker is required" >&2; exit 64; }
: "${DATABASE_URL_FILE:?DATABASE_URL_FILE is required}"
root=${ROLLOUT_TEST_SOURCE_ROOT:-$(git rev-parse --show-toplevel)}
temporary=$(mktemp -d /tmp/wb-rollout-db-integration.XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT
url=$(cat "$DATABASE_URL_FILE")
psql "$url" -v ON_ERROR_STOP=1 -f "$root/deployment/prepare-isolated-restore-runtime-role.sql" >/dev/null
psql "$url" -v ON_ERROR_STOP=1 -f "$root/deployment/prepare-isolated-restore-runtime-role.sql" >/dev/null
psql "$url" -v ON_ERROR_STOP=1 -c 'ALTER ROLE tender_api_runtime LOGIN' >/dev/null
if psql "$url" -v ON_ERROR_STOP=1 -f "$root/deployment/prepare-isolated-restore-runtime-role.sql" >/dev/null 2>&1; then
  echo "unsafe existing isolated runtime role was accepted" >&2
  exit 1
fi
psql "$url" -v ON_ERROR_STOP=1 -c 'ALTER ROLE tender_api_runtime NOLOGIN' >/dev/null
psql "$url" -v ON_ERROR_STOP=1 -f "$root/tests/fixtures/rollout-minimal.sql" >/dev/null
mkdir "$temporary/before" "$temporary/after"
STATE_OUTPUT_DIR="$temporary/before" "$root/deployment/capture-rollout-db-state.sh"
mkdir "$temporary/trusted"
printf '*:*:*:*:unused\n' >"$temporary/pgpass"
chmod 0600 "$temporary/pgpass"
PGHOST="${ROLLOUT_TEST_ADMIN_PGHOST:-127.0.0.1}" \
PGPORT="${ROLLOUT_TEST_ADMIN_PGPORT:-5432}" PGUSER=postgres PGDATABASE=postgres \
PGPASSFILE="$temporary/pgpass" ROLLOUT_DATABASE_ADMIN_TRUSTED=true \
STATE_OUTPUT_DIR="$temporary/trusted" sh -s <"$root/deployment/capture-rollout-db-state.sh"
for item in schema.sha256 plans.sha256 migration-ledger.present migration-ledger.sha256 migration-snapshots.present migration-snapshots.sha256; do
  cmp -s "$temporary/before/$item" "$temporary/trusted/$item"
done
RELEASE_ID=0000000000000000000000000000000000000001 "$root/deployment/apply-release-migrations.sh" | tee "$temporary/migrations.log"
[[ "$(grep -c '^APPLIED_MIGRATION=' "$temporary/migrations.log")" -eq 11 ]]
[[ "$(psql "$url" -Atv ON_ERROR_STOP=1 -c "SELECT count(*) FROM tender.release_migrations")" == 11 ]]
psql "$url" -v ON_ERROR_STOP=1 -f "$root/tests/saas-usage-limits.integration.sql" >/dev/null
bash "$root/tests/saas-usage-concurrency.integration.sh"
[[ "$(psql "$url" -Atv ON_ERROR_STOP=1 -c "SELECT string_agg(display_name||':'||recommended_monthly_price_minor,',' ORDER BY code) FROM saas.plans WHERE code IN ('NORMAL','PROFESSIONAL','ENTERPRISE')")" == 'Enterprise:249000,Pro:99000,Business:149000' ]]
[[ "$(psql "$url" -Atv ON_ERROR_STOP=1 -c "SELECT has_table_privilege('wb_tender_api_login','iam.tender_login_challenges','SELECT,INSERT,DELETE') AND NOT has_table_privilege('wb_tender_api_login','iam.tender_login_challenges','UPDATE,TRUNCATE,REFERENCES,TRIGGER')")" == t ]]
[[ "$(psql "$url" -Atv ON_ERROR_STOP=1 -c "SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolcanlogin AND rolinherit AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member='tender_api_runtime'::regrole) FROM pg_roles WHERE rolname='tender_api_runtime'")" == t ]]
psql "$url" -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE wb_tender_api_login;
INSERT INTO iam.tender_login_challenges(challenge_hash,user_id,user_agent_hash,network_hash,expires_at)
VALUES(repeat('a',64),'00000000-0000-0000-0000-000000000001','browser','network',now()+interval '5 minutes');
SELECT challenge_hash FROM iam.tender_login_challenges WHERE challenge_hash=repeat('a',64);
DELETE FROM iam.tender_login_challenges WHERE challenge_hash=repeat('a',64);
SQL
runtime_url=${url/postgres@/wb_tender_api_login@}
psql "$runtime_url" -v ON_ERROR_STOP=1 -c "SELECT pg_sleep(300)" >/dev/null 2>&1 &
runtime_client=$!
for attempt in {1..30}; do
  [[ "$(psql "$url" -Atv ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='wb_tender_api_login'")" == 1 ]] && break
  sleep 1
done
[[ "$(psql "$url" -Atv ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='wb_tender_api_login'")" == 1 ]]
drain_result=$("$root/deployment/drain-runtime-database-sessions.sh")
wait "$runtime_client" 2>/dev/null || true
grep -qx 'RUNTIME_SESSIONS_TERMINATED=1' <<<"$drain_result"
grep -qx 'RUNTIME_SESSIONS_REMAINING=0' <<<"$drain_result"
APPLIED_MIGRATIONS_FILE="$temporary/migrations.log" RELEASE_ID=0000000000000000000000000000000000000001 LEDGER_EXISTED_BEFORE=false SNAPSHOT_EXISTED_BEFORE=false "$root/deployment/rollback-applied-release-migrations.sh"
STATE_OUTPUT_DIR="$temporary/after" "$root/deployment/capture-rollout-db-state.sh"
for item in schema.sha256 plans.sha256 migration-ledger.present migration-ledger.sha256 migration-snapshots.present migration-snapshots.sha256; do cmp -s "$temporary/before/$item" "$temporary/after/$item"; done
# Production already has 155-159. Rolling 156 back in the all-new test above
# would hide a lossy rollback of the later 161 price metadata update.
export RELEASE_ID=0000000000000000000000000000000000000002
"$root/deployment/apply-release-migrations.sh" >"$temporary/prefix-seed.log"
sed -n '/^ROLLBACK_MIGRATION=16[0-5]_/p' "$temporary/prefix-seed.log" >"$temporary/prefix-tail.log"
APPLIED_MIGRATIONS_FILE="$temporary/prefix-tail.log" LEDGER_EXISTED_BEFORE=true SNAPSHOT_EXISTED_BEFORE=true "$root/deployment/rollback-applied-release-migrations.sh"
psql "$url" -v ON_ERROR_STOP=1 <<'SQL'
CREATE OR REPLACE VIEW tender.current_tender_portal_mapping_truth AS
SELECT NULL::uuid tender_id,NULL::uuid portal_id,0::integer portal_mapping_count,
       'PREVIOUS_CUSTOM_RESOLUTION'::text mapping_status WHERE false;
ALTER VIEW tender.current_tender_portal_mapping_truth RESET(security_barrier);
ALTER VIEW tender.current_tender_portal_mapping_truth SET(security_invoker=true);
COMMENT ON VIEW tender.current_tender_portal_mapping_truth IS 'Preserve installed resolution and view options';
UPDATE saas.plans SET metadata=metadata||'{"setup_fee_minor":424242,"activation_fee_minor":121212,"rollback_sentinel":true}'::jsonb,
  updated_at='2026-08-01T00:00:00Z' WHERE code IN('NORMAL','PROFESSIONAL','ENTERPRISE');
INSERT INTO app.schema_migrations(version,description)
VALUES('0160-critical-region-portal-resolution','Preserve pre-existing application marker');
SQL
mkdir "$temporary/prefix-before" "$temporary/prefix-after"
STATE_OUTPUT_DIR="$temporary/prefix-before" "$root/deployment/capture-rollout-db-state.sh"
"$root/deployment/apply-release-migrations.sh" >"$temporary/production-pending.log"
[[ "$(grep -c '^APPLIED_MIGRATION=' "$temporary/production-pending.log")" == 6 ]]
APPLIED_MIGRATIONS_FILE="$temporary/production-pending.log" LEDGER_EXISTED_BEFORE=true SNAPSHOT_EXISTED_BEFORE=true "$root/deployment/rollback-applied-release-migrations.sh"
STATE_OUTPUT_DIR="$temporary/prefix-after" "$root/deployment/capture-rollout-db-state.sh"
for item in schema.sha256 plans.sha256 migration-ledger.present migration-ledger.sha256 migration-snapshots.present migration-snapshots.sha256; do cmp -s "$temporary/prefix-before/$item" "$temporary/prefix-after/$item"; done
[[ "$(psql "$url" -Atv ON_ERROR_STOP=1 -c "SELECT description FROM app.schema_migrations WHERE version='0160-critical-region-portal-resolution'")" == 'Preserve pre-existing application marker' ]]
printf '{"passed":true,"isolatedPostgres":true,"pendingMigrations":11,"productionPrefixPendingMigrations":6,"runtimeLoginInheritedLeastPrivilege":true,"runtimeSessionsDrainedBeforeRollback":true,"exactReverseRollback":true,"schemaLedgerSnapshotPlansRestored":true,"installedViewAndPriceMetadataPreserved":true}\n'
