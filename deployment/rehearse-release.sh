#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
deployment_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source "$deployment_dir/lib/encrypted-pg-archive.sh"
required=(SOURCE_COMMIT SOURCE_TREE RELEASE_IMAGE POSTGRES_IMAGE BROWSER_IMAGE SOURCE_DUMP SOURCE_DUMP_SHA256 SOURCE_DUMP_ENCRYPTION_KEY_FILE EVIDENCE_FILE WIKOS_REAL_TEST_RESULT_FILE)
for name in "${required[@]}"; do [[ -n "${!name:-}" ]] || { echo "missing required environment: $name" >&2; exit 64; }; done
for name in RELEASE_IMAGE POSTGRES_IMAGE BROWSER_IMAGE; do [[ "${!name}" == *@sha256:* ]] || { echo "$name must be digest pinned" >&2; exit 64; }; done
REHEARSAL_COMPOSE_FILE=${REHEARSAL_COMPOSE_FILE:-deployment/compose.rehearsal.yml}
for file in "$REHEARSAL_COMPOSE_FILE" "$SOURCE_DUMP" "$SOURCE_DUMP_ENCRYPTION_KEY_FILE"; do [[ -r "$file" ]] || { echo "required rehearsal file is unreadable: $file" >&2; exit 66; }; done
[[ -f "$SOURCE_DUMP_ENCRYPTION_KEY_FILE" && ! -L "$SOURCE_DUMP_ENCRYPTION_KEY_FILE" ]] || { echo "rehearsal encryption key must be a regular non-symlink file" >&2; exit 66; }
key_mode=$(stat -c '%a' "$SOURCE_DUMP_ENCRYPTION_KEY_FILE")
(( (8#$key_mode & 077) == 0 && (8#$key_mode & 0700) <= 0600 )) || { echo "rehearsal encryption key must have mode 0600 or stricter" >&2; exit 66; }
command -v docker >/dev/null || { echo "docker is required" >&2; exit 69; }
command -v gpg >/dev/null || { echo "gpg is required" >&2; exit 69; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 69; }
for image in "$RELEASE_IMAGE" "$POSTGRES_IMAGE" "$BROWSER_IMAGE"; do
  docker image inspect "$image" >/dev/null 2>&1 || { echo "digest-pinned rehearsal image is unavailable locally: ${image%@sha256:*}" >&2; exit 69; }
done
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "SOURCE_COMMIT must be an exact commit id" >&2; exit 64; }
[[ "$SOURCE_TREE" =~ ^[0-9a-f]{40}$ ]] || { echo "SOURCE_TREE must be an exact tree id" >&2; exit 64; }
[[ "$(git rev-parse "$SOURCE_COMMIT^{tree}")" == "$SOURCE_TREE" ]] || { echo "SOURCE_TREE does not belong to SOURCE_COMMIT" >&2; exit 65; }
[[ ! -e "$EVIDENCE_FILE" && ! -e "$WIKOS_REAL_TEST_RESULT_FILE" ]] || { echo "evidence outputs must not already exist" >&2; exit 65; }
[[ "$(sha256sum "$SOURCE_DUMP" | cut -d' ' -f1)" == "$SOURCE_DUMP_SHA256" ]] || { echo "source dump checksum mismatch" >&2; exit 65; }
decrypt_archive() { gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$SOURCE_DUMP_ENCRYPTION_KEY_FILE" --decrypt "$SOURCE_DUMP"; }
if ! toc=$(verify_encrypted_pg_archive_catalog decrypt_archive); then
  echo "encrypted source archive catalog is unreadable" >&2
  exit 65
fi
[[ "$(grep -c '^[0-9]' <<<"$toc")" -ge 1000 ]] || { echo "source dump is not a complete database archive" >&2; exit 65; }
for schema in iam saas tender; do grep -q "SCHEMA - $schema " <<<"$toc" || { echo "source dump missing schema: $schema" >&2; exit 65; }; done

commit=$SOURCE_COMMIT
project="wb-tender-rehearsal-${commit:0:12}"
release_digest=${RELEASE_IMAGE##*@}
release_id=$(docker image inspect "$RELEASE_IMAGE" --format '{{.Id}}')
release_revision=$(docker image inspect "$RELEASE_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
release_tree=$(docker image inspect "$RELEASE_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.source-tree"}}')
[[ "$release_revision" == "$commit" ]] || { echo "release image source revision mismatch" >&2; exit 65; }
[[ "$release_tree" == "$SOURCE_TREE" ]] || { echo "release image source tree mismatch" >&2; exit 65; }
WIKOS_EVIDENCE_FILE="$WIKOS_REAL_TEST_RESULT_FILE" RELEASE_IMAGE_DIGEST="$release_digest" SOURCE_COMMIT="$commit" node scripts/probe-wikos-real-contract.mjs
wikos_evidence_sha256=$(sha256sum "$WIKOS_REAL_TEST_RESULT_FILE" | cut -d' ' -f1)
secret_dir=$(mktemp -d /tmp/wb-tender-rehearsal-secrets.XXXXXX)
cleanup() {
  status=$?
  trap - EXIT
  cleanup_failed=0
  if [[ "${fixture_seeded:-false}" == true ]]; then
    docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" run --rm -T -v "$secret_dir:/run/rehearsal:ro" -e REHEARSAL_SECRET_DIR=/run/rehearsal tools node scripts/release-rehearsal-fixture.mjs cleanup || cleanup_failed=1
  fi
  docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || cleanup_failed=1
  find "$secret_dir" -type f -exec sh -c 'for file do : >"$file"; done' sh {} + 2>/dev/null || true
  rm -rf "$secret_dir"
  if (( cleanup_failed != 0 )); then echo "rehearsal fixture/container cleanup failed" >&2; exit 79; fi
  exit "$status"
}
trap cleanup EXIT
fixture_seeded=false
export REHEARSAL_SECRET_DIR="$secret_dir"
node scripts/release-rehearsal-fixture.mjs generate
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=tls-proxy \
  -keyout "$secret_dir/tls_key" -out "$secret_dir/tls_cert" >/dev/null 2>&1
chmod 0600 "$secret_dir/tls_key" "$secret_dir/tls_cert"
export DATABASE_URL_FILE="$secret_dir/database_url"
export RUNTIME_DATABASE_URL_FILE="$secret_dir/runtime_database_url"
export SESSION_PEPPER_FILE="$secret_dir/session_pepper"
export FIELD_ENCRYPTION_KEY_FILE="$secret_dir/field_encryption_key"
export PORTAL_CREDENTIAL_KEY_FILE="$secret_dir/portal_credential_key"
export E2E_EMAIL_FILE="$secret_dir/e2e_email"
export E2E_PASSWORD_FILE="$secret_dir/e2e_password"
export E2E_TOTP_FILE="$secret_dir/e2e_totp"
export TLS_KEY_FILE="$secret_dir/tls_key"
export TLS_CERT_FILE="$secret_dir/tls_cert"
export RELEASE_IMAGE POSTGRES_IMAGE BROWSER_IMAGE EXTERNAL_SUBMISSION_ENABLED=false WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false

docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" config --quiet
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" up -d db
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db sh -c 'until pg_isready -U postgres -d wb_rehearsal; do sleep 1; done'
decrypt_archive | docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db pg_restore -U postgres --exit-on-error --clean --if-exists --no-owner --no-acl -d wb_rehearsal
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" run --rm -T -e REHEARSAL_DATABASE_TRUSTED=true tools deployment/verify-rehearsal-prerequisites.sh

before=$(docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db psql -U postgres -At -d wb_rehearsal -c "SELECT encode(digest(coalesce(jsonb_agg(to_jsonb(p) ORDER BY code)::text,''),'sha256'),'hex') FROM saas.plans p WHERE code IN ('CORE','NORMAL','PROFESSIONAL','ENTERPRISE')")
ledger_before=$(docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db psql -U postgres -At -d wb_rehearsal -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='tender' AND table_name='release_migrations'")
snapshot_table_before=$(docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db psql -U postgres -At -d wb_rehearsal -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='tender' AND table_name='release_plan_snapshots'")
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" run --rm -T -e REHEARSAL_DATABASE_TRUSTED=true -e RELEASE_ID="$commit" tools deployment/apply-release-migrations.sh
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" run --rm -T -v "$secret_dir:/run/rehearsal:ro" -e REHEARSAL_SECRET_DIR=/run/rehearsal tools node scripts/release-rehearsal-fixture.mjs prepare-runtime
iam_snapshot_sql="SELECT encode(digest(concat_ws('|',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id)::text,'') FROM iam.users x),(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id)::text,'') FROM iam.roles x),(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY user_id,role_id)::text,'') FROM iam.user_roles x),(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY role_id,permission_id)::text,'') FROM iam.role_permissions x),(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY user_id,scope_type,scope_id)::text,'') FROM iam.tender_identity_scopes x),(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id_hash)::text,'') FROM iam.sessions x),(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id)::text,'') FROM iam.login_attempts x),(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY challenge_hash)::text,'') FROM iam.tender_login_challenges x)),'sha256'),'hex')"
iam_before=$(docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db psql -U postgres -At -d wb_rehearsal -c "$iam_snapshot_sql")
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" run --rm -T \
  -e WB_TENDER_ISOLATION_TEST_DATABASE=true \
  -e DATABASE_URL_FILE=/run/secrets/runtime_database_url \
  -e TEST_DATABASE_ADMIN_URL_FILE=/run/secrets/database_url \
  tools node scripts/tenant-isolation-integration.mjs
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" run --rm -T \
  -e WB_ADMIN_ISOLATION_TEST_DATABASE=true \
  -e DATABASE_URL_FILE=/run/secrets/runtime_database_url \
  -e TEST_DATABASE_ADMIN_URL_FILE=/run/secrets/database_url \
  tools node scripts/admin-real-tenant-integration.mjs

if docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db psql -U postgres -v ON_ERROR_STOP=1 -d wb_rehearsal -c "UPDATE saas.plans SET recommended_monthly_price_minor=1 WHERE code='NORMAL'" >/dev/null 2>&1; then
  echo "server-side approved price boundary is not enforced" >&2
  exit 1
fi
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db psql -U postgres -At -d wb_rehearsal -c "SELECT code||':'||recommended_monthly_price_minor FROM saas.plans WHERE code IN ('NORMAL','PROFESSIONAL','ENTERPRISE') ORDER BY code" | grep -qx $'ENTERPRISE:249000\nNORMAL:99000\nPROFESSIONAL:149000'

docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" up -d --wait --wait-timeout 180 api worker scheduler tls-proxy wikos-stub
for service in api worker scheduler; do
  id=$(docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" ps -q "$service")
  [[ -n "$id" && "$(docker inspect "$id" --format '{{.Image}}')" == "$release_id" ]] || { echo "runtime image mismatch: $service" >&2; exit 1; }
done
for service in api worker scheduler; do
  [[ "$(docker inspect "$(docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" ps -q "$service")" --format '{{.State.Health.Status}}')" == healthy ]] || { echo "runtime health failed: $service" >&2; exit 1; }
done
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T api npm run gate:readiness
# Seed after the API's one-time startup reconcilers have completed. Those real
# reconcilers intentionally supersede approval bindings when they normalize
# restored required-document rows; the fixture must bind the resulting stable
# application state, not race that startup work.
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" run --rm -T -v "$secret_dir:/run/rehearsal:ro" -e REHEARSAL_SECRET_DIR=/run/rehearsal tools node scripts/release-rehearsal-fixture.mjs seed
fixture_seeded=true
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" run --rm -T browser node scripts/release-browser-e2e.mjs
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" run --rm -T tools node --input-type=module -e "import{wikOSConfiguration,verifyWikosReadContract}from'./platform/wikos-connector.mjs';const result=await verifyWikosReadContract(wikOSConfiguration({NODE_ENV:'test',WIKOS_LOCAL_STUB:'true'}));if(!result.verified||result.externalWrite)process.exit(1)"
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" run --rm -T -v "$secret_dir:/run/rehearsal:ro" -e REHEARSAL_SECRET_DIR=/run/rehearsal tools node scripts/release-rehearsal-fixture.mjs cleanup
fixture_seeded=false
iam_after=$(docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db psql -U postgres -At -d wb_rehearsal -c "$iam_snapshot_sql")
[[ "$iam_before" == "$iam_after" ]] || { echo "synthetic browser IAM rows were not exactly restored" >&2; exit 1; }

docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" stop api worker scheduler
REHEARSAL_FORCE_FAILURE=after_migrations deployment/rehearsal/rollback-probe.sh "$project" "$REHEARSAL_COMPOSE_FILE" "$commit"
after=$(docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db psql -U postgres -At -d wb_rehearsal -c "SELECT encode(digest(coalesce(jsonb_agg(to_jsonb(p) ORDER BY code)::text,''),'sha256'),'hex') FROM saas.plans p WHERE code IN ('CORE','NORMAL','PROFESSIONAL','ENTERPRISE')")
[[ "$before" == "$after" ]] || { echo "rollback did not restore exact plan rows" >&2; exit 1; }
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db psql -U postgres -At -d wb_rehearsal -c "SELECT count(*) FROM tender.release_migrations WHERE name IN ('155_autopilot_overview_latest_lookup.sql','156_approved_tender_commercial_plans.sql','157_release_auth_and_commercial_enforcement.sql','158_tender_login_challenge_runtime_grants.sql')" | grep -qx 0
docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db psql -U postgres -At -d wb_rehearsal -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='iam' AND table_name='tender_login_challenges'" | grep -qx 0
[[ "$snapshot_table_before" != 0 ]] || docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db psql -U postgres -v ON_ERROR_STOP=1 -d wb_rehearsal -c "DROP TABLE tender.release_plan_snapshots"
[[ "$ledger_before" != 0 ]] || docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db psql -U postgres -v ON_ERROR_STOP=1 -d wb_rehearsal -c "DROP TABLE tender.release_migrations"
ledger_after=$(docker compose -p "$project" -f "$REHEARSAL_COMPOSE_FILE" exec -T db psql -U postgres -At -d wb_rehearsal -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='tender' AND table_name IN ('release_migrations','release_plan_snapshots')")
[[ "$ledger_after" -eq $((ledger_before + snapshot_table_before)) ]] || { echo "rollback did not restore prior migration ledger table state" >&2; exit 1; }

grep -qx 'RESULT=PASS' "$WIKOS_REAL_TEST_RESULT_FILE" || { echo "real WIKOS contract test did not pass" >&2; exit 78; }
grep -qx 'READ_ONLY=true' "$WIKOS_REAL_TEST_RESULT_FILE" || { echo "real WIKOS evidence is not read-only" >&2; exit 78; }
grep -qx 'EXTERNAL_WRITE=false' "$WIKOS_REAL_TEST_RESULT_FILE" || { echo "real WIKOS evidence permits external writes" >&2; exit 78; }
printf 'EVIDENCE_VERSION=1\nSOURCE_COMMIT=%s\nSOURCE_TREE=%s\nRELEASE_IMAGE_ID=%s\nRELEASE_IMAGE_DIGEST=%s\nSOURCE_DUMP_SHA256=%s\nWIKOS_EVIDENCE_SHA256=%s\nRESULT=PASS\nPLAN_ROWS_SHA256=%s\nIAM_ROWS_SHA256=%s\nFIXTURE_NAMESPACE=WB_RELEASE_REHEARSAL_20260904\nFIXTURE_CLEANUP_ABSENCE=PASS\nTENANT_ISOLATION=PASS\nRBAC_ISOLATION=PASS\nBROWSER_PASSWORD_MFA_RETURNTO=PASS\nDOCUMENT_WORKFLOW=PASS\nCALCULATION_WORKFLOW=PASS\nMANAGEMENT_WORKFLOW=PASS\nTASK_WORKFLOW=PASS\nREMINDER_WORKFLOW=PASS\nHTTP423=PASS\nWIKOS_REAL=PASS\nWIKOS_STUB_COMPONENT=PASS\nSAME_IMAGE_API_WORKER_SCHEDULER=PASS\nSCHEDULER=PASS\nROLLBACK=PASS\nEXTERNAL_SUBMISSION=false\n' "$commit" "$SOURCE_TREE" "$release_id" "$release_digest" "$SOURCE_DUMP_SHA256" "$wikos_evidence_sha256" "$after" "$iam_after" >"$EVIDENCE_FILE"
chmod 0600 "$EVIDENCE_FILE"
