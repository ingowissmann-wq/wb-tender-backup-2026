#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
deployment_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source "$deployment_dir/lib/encrypted-pg-archive.sh"

required=(BACKUP_FILE BACKUP_MANIFEST BACKUP_MANIFEST_SHA256 BACKUP_ENCRYPTION_KEY_FILE POSTGRES_IMAGE RELEASE_IMAGE RELEASE_ID ISOLATED_RESTORE_RESULT_FILE)
for name in "${required[@]}"; do [[ -n "${!name:-}" ]] || { echo "missing required environment: $name" >&2; exit 64; }; done
for name in POSTGRES_IMAGE RELEASE_IMAGE; do [[ "${!name}" == *@sha256:* ]] || { echo "$name must be digest pinned" >&2; exit 64; }; done
for file in "$BACKUP_FILE" "$BACKUP_MANIFEST" "$BACKUP_MANIFEST_SHA256" "$BACKUP_ENCRYPTION_KEY_FILE"; do
  [[ -f "$file" && ! -L "$file" && -r "$file" ]] || { echo "isolated restore input is not a readable regular file: $file" >&2; exit 66; }
done
[[ ! -e "$ISOLATED_RESTORE_RESULT_FILE" ]] || { echo "isolated restore result already exists" >&2; exit 65; }

repository=$(git rev-parse --show-toplevel)
suffix="${RELEASE_ID:0:12}-$$"
network="wb-tender-restore-$suffix"
database_container="wb-tender-restore-db-$suffix"
secret_dir=$(mktemp -d /tmp/wb-tender-restore-secrets.XXXXXX)
database_url_file="$secret_dir/database_url"
database_admin_url_file="$secret_dir/database_admin_url"
network_created=false
container_created=false
printf 'postgresql://postgres@db/wb_restore\n' >"$database_url_file"
printf 'postgresql://postgres@db/wb_restore\n' >"$database_admin_url_file"
chmod 0600 "$database_url_file" "$database_admin_url_file"
cleanup() {
  status=$?
  trap - EXIT ERR INT TERM
  set +e
  remove_container_status=0
  remove_network_status=0
  [[ "$container_created" != true ]] || docker rm -fv "$database_container" >/dev/null 2>&1 || remove_container_status=$?
  [[ "$network_created" != true ]] || docker network rm "$network" >/dev/null 2>&1 || remove_network_status=$?
  find "$secret_dir" -type f -exec sh -c 'for file do : >"$file"; done' sh {} + 2>/dev/null
  rm -rf -- "$secret_dir"
  if (( remove_container_status != 0 || remove_network_status != 0 )); then
    echo "isolated restore cleanup failed; container=$remove_container_status network=$remove_network_status" >&2
    exit 86
  fi
  exit "$status"
}
trap cleanup EXIT ERR INT TERM

sha256sum -c "$BACKUP_MANIFEST_SHA256" >/dev/null
archive_sha=$(awk -F= '$1=="archive_sha256"{print $2}' "$BACKUP_MANIFEST")
plaintext_sha=$(awk -F= '$1=="plaintext_sha256"{print $2}' "$BACKUP_MANIFEST")
catalog_verified=$(awk -F= '$1=="pg_restore_list_verified"{print $2}' "$BACKUP_MANIFEST")
[[ "$archive_sha" =~ ^[0-9a-f]{64}$ && "$plaintext_sha" =~ ^[0-9a-f]{64}$ && "$catalog_verified" == true ]] || { echo "backup manifest is incomplete" >&2; exit 74; }
[[ "$(sha256sum "$BACKUP_FILE" | cut -d' ' -f1)" == "$archive_sha" ]] || { echo "backup ciphertext checksum mismatch" >&2; exit 74; }
decrypt() { gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_ENCRYPTION_KEY_FILE" --decrypt "$BACKUP_FILE"; }
[[ "$(decrypt | sha256sum | cut -d' ' -f1)" == "$plaintext_sha" ]] || { echo "backup plaintext checksum mismatch" >&2; exit 74; }
verify_encrypted_pg_archive_catalog decrypt >/dev/null || { echo "backup pg_restore catalog check failed" >&2; exit 74; }

docker network create --internal "$network" >/dev/null
network_created=true
[[ "$(docker network inspect "$network" --format '{{.Internal}}')" == true ]] || { echo "restore network is not internal" >&2; exit 78; }
docker run -d --name "$database_container" --network "$network" --network-alias db \
  -e POSTGRES_DB=wb_restore -e POSTGRES_HOST_AUTH_METHOD=trust "$POSTGRES_IMAGE" >/dev/null
container_created=true
for _ in $(seq 1 90); do
  docker exec "$database_container" pg_isready -U postgres -d wb_restore >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$database_container" pg_isready -U postgres -d wb_restore >/dev/null
[[ "$(docker inspect "$database_container" --format '{{len .NetworkSettings.Networks}}')" == 1 ]] || { echo "restore database has unexpected network connectivity" >&2; exit 78; }
decrypt | docker exec -i "$database_container" pg_restore -U postgres --exit-on-error --clean --if-exists --no-owner --no-acl -d wb_restore

run_tools() {
  docker run --rm --network "$network" --network-alias tools \
    -v "$repository:/app:ro" \
    -v "$database_url_file:/run/secrets/database_url:ro" \
    -v "$database_admin_url_file:/run/secrets/test_database_admin_url:ro" \
    -w /app -e DATABASE_URL_FILE=/run/secrets/database_url -e TEST_DATABASE_ADMIN_URL_FILE=/run/secrets/test_database_admin_url \
    "$RELEASE_IMAGE" "$@"
}
run_tools env ISOLATED_RESTORE_DATABASE_TRUSTED=true deployment/verify-rehearsal-prerequisites.sh
run_tools env RELEASE_ID="$RELEASE_ID" deployment/apply-release-migrations.sh

docker exec -i "$database_container" psql -U postgres -d wb_restore -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE wb_restore_runtime
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOLOGIN;
GRANT CONNECT ON DATABASE wb_restore TO wb_restore_runtime;
DO $grant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname NOT LIKE 'pg_%'
      AND nspname <> 'information_schema'
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO wb_restore_runtime', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO wb_restore_runtime', schema_name);
    EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO wb_restore_runtime', schema_name);
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO wb_restore_runtime', schema_name);
  END LOOP;
END
$grant$;
SQL
runtime_role_safe=$(docker exec "$database_container" psql -U postgres -At -d wb_restore -c \
  "SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb FROM pg_roles WHERE rolname='wb_restore_runtime'")
[[ "$runtime_role_safe" == t ]] || { echo "isolated restore runtime role is privileged" >&2; exit 78; }
printf '%s\n' 'postgresql://postgres@db/wb_restore?options=-c%20role%3Dwb_restore_runtime' >"$database_url_file"

run_tools env WB_TENDER_ISOLATION_TEST_DATABASE=true node scripts/tenant-isolation-integration.mjs
run_tools env WB_ADMIN_ISOLATION_TEST_DATABASE=true node scripts/admin-real-tenant-integration.mjs
prices=$(docker exec "$database_container" psql -U postgres -At -d wb_restore -c "SELECT display_name||':'||recommended_monthly_price_minor FROM saas.plans WHERE code IN ('NORMAL','PROFESSIONAL','ENTERPRISE') ORDER BY code")
[[ "$prices" == $'Enterprise:249000\nPro:99000\nBusiness:149000' ]] || { echo "isolated restore commercial limits gate failed" >&2; exit 78; }
transmitted=$(docker exec "$database_container" psql -U postgres -At -d wb_restore -c "SELECT count(*) FROM tender.external_action_receipts")
[[ "$transmitted" == 0 ]] || { echo "isolated restore contains external action receipts" >&2; exit 78; }

printf 'RESULT=PASS\nRELEASE_ID=%s\nBACKUP_CIPHERTEXT_SHA256=%s\nBACKUP_PLAINTEXT_SHA256=%s\nNETWORK_INTERNAL=true\nPENDING_MIGRATIONS_ONLY=true\nDB_INTEGRATION_GATES=PASS\nEXTERNAL_SUBMISSION=false\n' \
  "$RELEASE_ID" "$archive_sha" "$plaintext_sha" >"$ISOLATED_RESTORE_RESULT_FILE"
chmod 0600 "$ISOLATED_RESTORE_RESULT_FILE"
