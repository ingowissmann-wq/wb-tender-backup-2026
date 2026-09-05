#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ "${WB_TENDER_ROLLOUT_ISOLATED_TEST:-false}" == true ]] || { echo "isolated rollout database test marker is required" >&2; exit 64; }
: "${DATABASE_URL_FILE:?DATABASE_URL_FILE is required}"
root=$(git rev-parse --show-toplevel)
temporary=$(mktemp -d /tmp/wb-rollout-db-integration.XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT
url=$(cat "$DATABASE_URL_FILE")
psql "$url" -v ON_ERROR_STOP=1 -f "$root/tests/fixtures/rollout-minimal.sql" >/dev/null
mkdir "$temporary/before" "$temporary/after"
STATE_OUTPUT_DIR="$temporary/before" "$root/deployment/capture-rollout-db-state.sh"
RELEASE_ID=0000000000000000000000000000000000000001 "$root/deployment/apply-release-migrations.sh" | tee "$temporary/migrations.log"
[[ "$(grep -c '^APPLIED_MIGRATION=' "$temporary/migrations.log")" -eq 5 ]]
[[ "$(psql "$url" -Atv ON_ERROR_STOP=1 -c "SELECT count(*) FROM tender.release_migrations")" == 5 ]]
[[ "$(psql "$url" -Atv ON_ERROR_STOP=1 -c "SELECT string_agg(display_name||':'||recommended_monthly_price_minor,',' ORDER BY code) FROM saas.plans WHERE code IN ('NORMAL','PROFESSIONAL','ENTERPRISE')")" == 'Enterprise:249000,Pro:99000,Business:149000' ]]
[[ "$(psql "$url" -Atv ON_ERROR_STOP=1 -c "SELECT has_table_privilege('wb_tender_api_login','iam.tender_login_challenges','SELECT,INSERT,DELETE') AND NOT has_table_privilege('wb_tender_api_login','iam.tender_login_challenges','UPDATE,TRUNCATE,REFERENCES,TRIGGER')")" == t ]]
psql "$url" -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE wb_tender_api_login;
INSERT INTO iam.tender_login_challenges(challenge_hash,user_id,user_agent_hash,network_hash,expires_at)
VALUES(repeat('a',64),'00000000-0000-0000-0000-000000000001','browser','network',now()+interval '5 minutes');
SELECT challenge_hash FROM iam.tender_login_challenges WHERE challenge_hash=repeat('a',64);
DELETE FROM iam.tender_login_challenges WHERE challenge_hash=repeat('a',64);
SQL
APPLIED_MIGRATIONS_FILE="$temporary/migrations.log" RELEASE_ID=0000000000000000000000000000000000000001 LEDGER_EXISTED_BEFORE=false SNAPSHOT_EXISTED_BEFORE=false "$root/deployment/rollback-applied-release-migrations.sh"
STATE_OUTPUT_DIR="$temporary/after" "$root/deployment/capture-rollout-db-state.sh"
for item in schema.sha256 plans.sha256 migration-ledger.present migration-ledger.sha256 migration-snapshots.present migration-snapshots.sha256; do cmp -s "$temporary/before/$item" "$temporary/after/$item"; done
printf '{"passed":true,"isolatedPostgres":true,"pendingMigrations":5,"runtimeLoginInheritedLeastPrivilege":true,"exactReverseRollback":true,"schemaLedgerSnapshotPlansRestored":true}\n'
