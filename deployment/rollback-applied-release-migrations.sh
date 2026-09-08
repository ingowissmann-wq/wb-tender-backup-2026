#!/usr/bin/env bash
set -Eeuo pipefail
: "${DATABASE_URL_FILE:?DATABASE_URL_FILE is required}"
: "${APPLIED_MIGRATIONS_FILE:?APPLIED_MIGRATIONS_FILE is required}"
: "${RELEASE_ID:?RELEASE_ID is required}"
: "${LEDGER_EXISTED_BEFORE:?LEDGER_EXISTED_BEFORE is required}"
: "${SNAPSHOT_EXISTED_BEFORE:?SNAPSHOT_EXISTED_BEFORE is required}"
[[ -r "$DATABASE_URL_FILE" && -r "$APPLIED_MIGRATIONS_FILE" ]] || { echo "rollback input file is unreadable" >&2; exit 66; }
[[ "$RELEASE_ID" =~ ^[0-9a-f]{40}$ ]] || { echo "RELEASE_ID must be an exact git commit" >&2; exit 64; }
url=$(cat "$DATABASE_URL_FILE")
mapfile -t applied < <(sed -n 's/^ROLLBACK_MIGRATION=//p' "$APPLIED_MIGRATIONS_FILE")
declare -A seen=()
for name in "${applied[@]}"; do
  [[ -z "${seen[$name]:-}" ]] || { echo "duplicate applied migration record: $name" >&2; exit 65; }
  seen[$name]=1
  case "$name" in
    155_autopilot_overview_latest_lookup.sql|156_approved_tender_commercial_plans.sql|157_release_auth_and_commercial_enforcement.sql|158_tender_login_challenge_runtime_grants.sql|159_runtime_request_scope.sql|160_critical_region_portal_resolution.sql|161_saas_self_service_checkout_and_oidc.sql|162_saas_native_self_service_iam.sql|163_saas_split_billing_collection.sql|164_saas_explicit_standalone_booking.sql|165_saas_atomic_usage_limits.sql|166_saas_booking_email_outbox.sql|167_tenant_portal_credential_vault.sql|168_tenant_company_profile_versions.sql|169_tenant_lot_assignments.sql|170_tenant_lot_calculations.sql|171_tenant_management_decisions.sql|172_tenant_document_reviews.sql|173_tenant_offer_packages.sql|174_tenant_portal_sessions.sql|175_tenant_workflow_tasks.sql|176_saas_native_invitation_enrollment.sql) ;;
    *) echo "refusing unknown rollback migration: $name" >&2; exit 65 ;;
  esac
done
for (( index=${#applied[@]}-1; index>=0; index-- )); do
  name=${applied[$index]}
  case "$name" in
    176_saas_native_invitation_enrollment.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f migrations/176_saas_native_invitation_enrollment.down.sql ;;
    175_tenant_workflow_tasks.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f migrations/175_tenant_workflow_tasks.down.sql ;;
    174_tenant_portal_sessions.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f migrations/174_tenant_portal_sessions.down.sql ;;
    173_tenant_offer_packages.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f migrations/173_tenant_offer_packages.down.sql ;;
    172_tenant_document_reviews.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f migrations/172_tenant_document_reviews.down.sql ;;
    171_tenant_management_decisions.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f migrations/171_tenant_management_decisions.down.sql ;;
    170_tenant_lot_calculations.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f migrations/170_tenant_lot_calculations.down.sql ;;
    169_tenant_lot_assignments.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f migrations/169_tenant_lot_assignments.down.sql ;;
    168_tenant_company_profile_versions.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f migrations/168_tenant_company_profile_versions.down.sql ;;
    167_tenant_portal_credential_vault.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f migrations/167_tenant_portal_credential_vault.down.sql ;;
    166_saas_booking_email_outbox.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f migrations/166_saas_booking_email_outbox.down.sql ;;
    165_saas_atomic_usage_limits.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f migrations/165_saas_atomic_usage_limits.down.sql ;;
    164_saas_explicit_standalone_booking.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f migrations/164_saas_explicit_standalone_booking.down.sql ;;
    163_saas_split_billing_collection.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f migrations/163_saas_split_billing_collection.down.sql ;;
    162_saas_native_self_service_iam.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f migrations/162_saas_native_self_service_iam.down.sql ;;
    161_saas_self_service_checkout_and_oidc.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f migrations/161_saas_self_service_checkout_and_oidc.down.sql ;;
    160_critical_region_portal_resolution.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f migrations/160_critical_region_portal_resolution.down.sql ;;
    159_runtime_request_scope.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f migrations/159_runtime_request_scope.down.sql ;;
    158_tender_login_challenge_runtime_grants.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f migrations/158_tender_login_challenge_runtime_grants.down.sql ;;
    157_release_auth_and_commercial_enforcement.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f deployment/rollback-release-auth-and-commercial-enforcement.sql ;;
    156_approved_tender_commercial_plans.sql)
      psql "$url" -v ON_ERROR_STOP=1 -v release_id="$RELEASE_ID" <<'SQL'
SET wb.release_id=:'release_id';
\i deployment/rollback-approved-tender-commercial-plans.sql
SQL
      ;;
    155_autopilot_overview_latest_lookup.sql)
      psql "$url" -v ON_ERROR_STOP=1 -f deployment/rollback-autopilot-overview-latest-lookup.sql ;;
  esac
  psql "$url" -v ON_ERROR_STOP=1 -v name="$name" <<'SQL'
DELETE FROM tender.release_migrations WHERE name=:'name';
SQL
done
if [[ "$SNAPSHOT_EXISTED_BEFORE" == false ]]; then
  psql "$url" -v ON_ERROR_STOP=1 -c "DROP TABLE IF EXISTS tender.release_plan_snapshots"
fi
if [[ "$LEDGER_EXISTED_BEFORE" == false ]]; then
  psql "$url" -v ON_ERROR_STOP=1 -c "DROP TABLE IF EXISTS tender.release_migrations"
fi
