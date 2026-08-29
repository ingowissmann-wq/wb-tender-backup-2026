#!/usr/bin/env bash
set -Eeuo pipefail

: "${EXPECTED_COMMIT:?EXPECTED_COMMIT is required}"

container=${RESTORE_CONTAINER:-wb-tender-restore-verify-20260828T211025Z-db}
database=${RESTORE_DATABASE:-wb_platform_restore}
database_user=${RESTORE_DATABASE_USER:-restore_admin}
approved_value=0.5
approved_unit=EUR_PER_HOUR
approval_date=2026-08-29
approval_actor_id=fe93f980-5699-44f4-ad41-69d254dcaa9f
approval_actor_email=admin@wb-holding.ag
tenant_id=1df0552d-34e0-4bc6-8205-e1fae02a90de
company_id=15c3c602-aa51-4dd4-adc1-3586dc82e523
canonical_service=cleaning
profile_id=447c8ef1-39e2-4ec0-a053-0dadd5b01e0b
service_line=cleaning
business_approval_id=WB-C11-050-EUR-PER-HOUR-20260829

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(git -C "$script_dir/.." rev-parse --show-toplevel)

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
scalar() {
  docker exec "$container" psql -U "$database_user" -d "$database" -X -A -t -v ON_ERROR_STOP=1 -c "$1"
}
protected_fingerprint() {
  scalar "SELECT concat_ws('|',
    (SELECT count(*) FROM tender.tenders),
    (SELECT count(*) FROM tender.enrichment_documents),
    (SELECT count(*) FROM tender.enrichment_fields),
    (SELECT count(*) FROM tender.calculations),
    (SELECT count(*) FROM tender.region_evaluations),
    (SELECT count(*) FROM tender.external_action_receipts),
    (SELECT count(*) FROM tender.submission_receipts),
    (SELECT count(*) FROM tender.autopilot_queue)
  )"
}
configuration_fingerprint() {
  scalar "SELECT concat_ws('|',
    (SELECT count(*) FROM tender.configuration_versions),
    (SELECT count(*) FROM tender.configuration_changes),
    (SELECT count(*) FROM tender.configuration_active_parameters),
    (SELECT count(*) FROM tender.configuration_audit),
    (SELECT count(*) FROM tender.configuration_active_parameters WHERE parameter_key='C11')
  )"
}

printf '===== SOURCE AND ISOLATED-CLONE GATE =====\n'
actual_commit=$(git -C "$root" rev-parse HEAD)
actual_tree=$(git -C "$root" rev-parse 'HEAD^{tree}')
test "$actual_commit" = "$EXPECTED_COMMIT" || fail "source commit mismatch: expected=$EXPECTED_COMMIT actual=$actual_commit"
test -z "$(git -C "$root" status --porcelain)" || fail "source checkout is dirty"
test "$(docker inspect -f '{{.State.Running}}' "$container")" = true || fail "isolated clone is not running"
published=$(docker inspect -f '{{range $port,$bindings := .NetworkSettings.Ports}}{{if $bindings}}{{$port}}={{json $bindings}}{{end}}{{end}}' "$container")
test -z "$published" || fail "isolated clone publishes host ports: $published"
test "$database" = wb_platform_restore || fail "refusing non-restore database: $database"
test "$(scalar 'SELECT current_database()')" = "$database" || fail "restore database identity mismatch"
test "$(scalar "SELECT count(*) FROM app.schema_migrations WHERE version='0155-c23-canonical-calculation-contract'")" = 1 || fail "migration 155 candidate state is absent"
test "$(scalar "SELECT count(*) FROM app.schema_migrations WHERE version='0156-c11-hourly-material-contract'")" = 1 || fail "migration 156 candidate state is absent"
test "$(scalar "SELECT count(*) FROM pg_proc WHERE oid=to_regprocedure('digest(bytea,text)')")" = 1 || fail "required SHA-256 digest function is absent"
printf 'commit=%s\ntree=%s\ncontainer=%s\ndatabase=%s\n' "$actual_commit" "$actual_tree" "$container" "$database"

printf '\n===== EXACT SCOPE, ACTOR AND PREDECESSOR GATES =====\n'
scope_count=$(scalar "SELECT count(*) FROM tender.configuration_scopes WHERE tenant_id='$tenant_id'::uuid AND company_id='$company_id'::uuid AND canonical_service='$canonical_service' AND profile_id='$profile_id'::uuid")
test "$scope_count" = 1 || fail "expected exact WB-Cleaning/cleaning configuration scope once; found $scope_count"
company_count=$(scalar "SELECT count(*) FROM tender.enterprise_company_links WHERE company_id='$company_id'::uuid AND legal_name='WB-Cleaning GmbH' AND sector_slug='cleaning'")
test "$company_count" = 1 || fail "WB-Cleaning company identity mismatch"
actor_count=$(scalar "SELECT count(*) FROM iam.users user_row
  WHERE user_row.id='$approval_actor_id'::uuid
    AND lower(user_row.email)=lower('$approval_actor_email')
    AND user_row.active=true
    AND user_row.mfa_required=true
    AND EXISTS(SELECT 1 FROM iam.user_roles user_role JOIN iam.roles role_row ON role_row.id=user_role.role_id WHERE user_role.user_id=user_row.id AND role_row.code='board')
    AND EXISTS(SELECT 1 FROM iam.user_roles user_role JOIN iam.role_permissions role_permission ON role_permission.role_id=user_role.role_id JOIN iam.permissions permission_row ON permission_row.id=role_permission.permission_id WHERE user_role.user_id=user_row.id AND permission_row.code='tender.config.self_approve_activate')
    AND EXISTS(SELECT 1 FROM tender.configuration_audit audit WHERE audit.actor_id=user_row.id AND audit.action='BOARD_SELF_APPROVED')")
test "$actor_count" = 1 || fail "expected one proven MFA board approval actor; found $actor_count"

existing_exact=$(scalar "SELECT count(*) FROM tender.configuration_active_parameters active JOIN tender.configuration_changes change ON change.id=active.change_id JOIN tender.configuration_versions version ON version.id=active.version_id WHERE active.company_id='$company_id'::uuid AND active.service_line='$service_line' AND active.parameter_key='C11' AND change.new_value='0.5'::jsonb AND change.unit='EUR_PER_HOUR' AND change.source='Vorstandsfreigabe Dr. Ingo Wissmann vom 29.08.2026' AND version.status='ACTIVE' AND version.approved_by='$approval_actor_id'::uuid AND version.approved_at IS NOT NULL")
if [[ "$existing_exact" = 1 ]]; then
  printf 'PASS: approved C11=0.50 EUR_PER_HOUR is already active only in the exact WB-Cleaning scope; rerun is idempotent.\n'
  exit 0
fi
test "$existing_exact" = 0 || fail "duplicate approved C11 hourly state: rows=$existing_exact"

old_exact=$(scalar "SELECT count(*) FROM tender.configuration_active_parameters active JOIN tender.configuration_changes change ON change.id=active.change_id JOIN tender.configuration_versions version ON version.id=active.version_id WHERE active.company_id='$company_id'::uuid AND active.service_line='$service_line' AND active.parameter_key='C11' AND change.new_value='0.5'::jsonb AND change.unit='EUR_PER_UNIT' AND version.status='ACTIVE' AND version.version_no=61")
test "$old_exact" = 1 || fail "expected exact active predecessor C11=0.5 EUR_PER_UNIT version 61 once; found $old_exact"
total_scope_c11=$(scalar "SELECT count(*) FROM tender.configuration_active_parameters WHERE company_id='$company_id'::uuid AND service_line='$service_line' AND parameter_key='C11'")
test "$total_scope_c11" = 1 || fail "exact WB-Cleaning C11 pointer is not unique: rows=$total_scope_c11"
printf 'scope=WB-Cleaning GmbH/cleaning\napproval_actor=%s\napproved_C11=%s\napproved_unit=%s\napproval_date=%s\n' "$approval_actor_email" "$approved_value" "$approved_unit" "$approval_date"

before_protected=$(protected_fingerprint)
before_configuration=$(configuration_fingerprint)
printf 'before_protected=%s\nbefore_configuration=%s\n' "$before_protected" "$before_configuration"

printf '\n===== ATOMIC C11 UNIT CORRECTION IN ISOLATED CLONE =====\n'
docker exec -i "$container" psql -U "$database_user" -d "$database" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('configuration-active:15c3c602-aa51-4dd4-adc1-3586dc82e523:cleaning',0));

DO $activation$
DECLARE
  actor_id uuid := 'fe93f980-5699-44f4-ad41-69d254dcaa9f'::uuid;
  old_version_id uuid;
  old_change_id uuid;
  predecessor_id uuid;
  new_version_id uuid;
  new_change_id uuid;
  new_version_no bigint;
  payload_value jsonb;
  metadata_value jsonb;
BEGIN
  IF current_database()<>'wb_platform_restore' THEN
    RAISE EXCEPTION 'refusing_non_restore_database_%',current_database();
  END IF;

  SELECT active.version_id,active.change_id INTO STRICT old_version_id,old_change_id
  FROM tender.configuration_active_parameters active
  JOIN tender.configuration_changes change ON change.id=active.change_id
  JOIN tender.configuration_versions version ON version.id=active.version_id
  WHERE active.company_id='15c3c602-aa51-4dd4-adc1-3586dc82e523'::uuid
    AND active.service_line='cleaning'
    AND active.parameter_key='C11'
    AND change.new_value='0.5'::jsonb
    AND change.unit='EUR_PER_UNIT'
    AND version.status='ACTIVE'
    AND version.version_no=61
  FOR UPDATE OF active,version;

  SELECT id INTO STRICT predecessor_id
  FROM tender.configuration_versions
  WHERE tenant_id='1df0552d-34e0-4bc6-8205-e1fae02a90de'::uuid
    AND company_id='15c3c602-aa51-4dd4-adc1-3586dc82e523'::uuid
    AND canonical_service='cleaning'
    AND profile_id='447c8ef1-39e2-4ec0-a053-0dadd5b01e0b'::uuid
    AND service_line='cleaning'
  ORDER BY version_no DESC
  LIMIT 1
  FOR SHARE;

  payload_value=jsonb_build_object(
    'clientRequestId',gen_random_uuid()::text,
    'businessApprovalId','WB-C11-050-EUR-PER-HOUR-20260829',
    'tenantId','1df0552d-34e0-4bc6-8205-e1fae02a90de',
    'companyId','15c3c602-aa51-4dd4-adc1-3586dc82e523',
    'serviceLine','cleaning',
    'canonicalService','cleaning',
    'profileId','447c8ef1-39e2-4ec0-a053-0dadd5b01e0b',
    'source','Vorstandsfreigabe Dr. Ingo Wissmann vom 29.08.2026',
    'reason','C11 Materialkosten 0,50 Euro je produktiver Stunde für WB-Cleaning'
  );

  INSERT INTO tender.configuration_versions(
    predecessor_id,company_id,service_line,tenant_id,canonical_service,profile_id,
    source,reason,payload,checksum,created_by,status
  ) VALUES (
    predecessor_id,'15c3c602-aa51-4dd4-adc1-3586dc82e523'::uuid,'cleaning',
    '1df0552d-34e0-4bc6-8205-e1fae02a90de'::uuid,'cleaning',
    '447c8ef1-39e2-4ec0-a053-0dadd5b01e0b'::uuid,
    'Vorstandsfreigabe Dr. Ingo Wissmann vom 29.08.2026',
    'C11 Materialkosten 0,50 EUR je produktiver Stunde für WB-Cleaning',
    payload_value,encode(digest(convert_to(payload_value::text,'UTF8'),'sha256'),'hex'),
    actor_id,'DRAFT'
  ) RETURNING id,version_no INTO new_version_id,new_version_no;

  INSERT INTO tender.configuration_changes(
    version_id,category,parameter_key,old_value,new_value,unit,source,data_as_of,
    valid_from,valid_until,priority,complete,justification
  ) VALUES (
    new_version_id,'CALCULATION','C11','0.5'::jsonb,'0.5'::jsonb,'EUR_PER_HOUR',
    'Vorstandsfreigabe Dr. Ingo Wissmann vom 29.08.2026','2026-08-29'::date,
    '2026-08-29'::date,NULL,'C',false,
    '0,50 EUR je produktiver Stunde; ersetzt ausschließlich die mehrdeutige Mengeneinheit EUR_PER_UNIT im WB-Cleaning/cleaning-Scope'
  ) RETURNING id INTO new_change_id;

  INSERT INTO tender.configuration_audit(version_id,actor_id,action,metadata)
  VALUES
    (new_version_id,actor_id,'DRAFT_CREATED',jsonb_build_object('businessApprovalId','WB-C11-050-EUR-PER-HOUR-20260829','parameterKey','C11')),
    (new_version_id,actor_id,'CHANGE_SAVED',jsonb_build_object('parameterKey','C11','value',0.5,'unit','EUR_PER_HOUR','previousUnit','EUR_PER_UNIT'));

  UPDATE tender.configuration_versions
  SET status='APPROVED',
      validation=jsonb_build_object('valid',true,'errors',jsonb_build_array(),'checkedAt',clock_timestamp()),
      submitted_at=now(),approved_at=now(),approved_by=actor_id
  WHERE id=new_version_id AND status='DRAFT';

  UPDATE tender.configuration_active_parameters
  SET version_id=new_version_id,change_id=new_change_id,activated_at=now(),activated_by=actor_id
  WHERE company_id='15c3c602-aa51-4dd4-adc1-3586dc82e523'::uuid
    AND service_line='cleaning'
    AND parameter_key='C11'
    AND version_id=old_version_id
    AND change_id=old_change_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'C11_active_pointer_compare_and_swap_failed'; END IF;

  UPDATE tender.configuration_versions SET status='ACTIVE',activated_at=now()
  WHERE id=new_version_id AND status='APPROVED';

  metadata_value=jsonb_build_object(
    'notice','Selbstfreigabe aufgrund ausdrücklicher Vorstandsberechtigung',
    'businessApprovalId','WB-C11-050-EUR-PER-HOUR-20260829',
    'creatorId',actor_id,'approverId',actor_id,'activatorId',actor_id,
    'companyId','15c3c602-aa51-4dd4-adc1-3586dc82e523',
    'company','WB-Cleaning GmbH','serviceLine','cleaning','canonicalService','cleaning',
    'profileId','447c8ef1-39e2-4ec0-a053-0dadd5b01e0b',
    'versionNo',new_version_no,'parameterKey','C11','value',0.5,
    'unit','EUR_PER_HOUR','previousUnit','EUR_PER_UNIT'
  );
  INSERT INTO tender.configuration_audit(version_id,actor_id,action,metadata)
  VALUES
    (new_version_id,actor_id,'BOARD_SELF_APPROVED',metadata_value),
    (new_version_id,actor_id,'ACTIVE',metadata_value);

  IF (SELECT count(*) FROM tender.configuration_active_parameters active
      JOIN tender.configuration_changes change ON change.id=active.change_id
      JOIN tender.configuration_versions version ON version.id=active.version_id
      WHERE active.company_id='15c3c602-aa51-4dd4-adc1-3586dc82e523'::uuid
        AND active.service_line='cleaning' AND active.parameter_key='C11'
        AND change.new_value='0.5'::jsonb AND change.unit='EUR_PER_HOUR'
        AND change.valid_from='2026-08-29'::date AND change.valid_until IS NULL
        AND version.status='ACTIVE' AND version.approved_by=actor_id
        AND version.approved_at IS NOT NULL)=1 THEN NULL;
  ELSE RAISE EXCEPTION 'C11_exact_activation_postcondition_failed'; END IF;
END
$activation$;
COMMIT;
SQL

after_protected=$(protected_fingerprint)
after_configuration=$(configuration_fingerprint)
test "$after_protected" = "$before_protected" || fail "protected business fingerprint changed: before=$before_protected after=$after_protected"
IFS='|' read -r before_versions before_changes before_active before_audit before_c11 <<<"$before_configuration"
IFS='|' read -r after_versions after_changes after_active after_audit after_c11 <<<"$after_configuration"
test "$after_versions" -eq $((before_versions+1)) || fail "configuration version delta is not +1"
test "$after_changes" -eq $((before_changes+1)) || fail "configuration change delta is not +1"
test "$after_active" -eq "$before_active" || fail "active parameter count changed"
test "$after_audit" -eq $((before_audit+4)) || fail "configuration audit delta is not +4"
test "$after_c11" -eq "$before_c11" || fail "global active C11 count changed"

printf 'after_protected=%s\nafter_configuration=%s\n' "$after_protected" "$after_configuration"
docker exec -e 'PGOPTIONS=-c default_transaction_read_only=on' "$container" psql -U "$database_user" -d "$database" -X -P pager=off -v ON_ERROR_STOP=1 -c "
SELECT company.legal_name,version.canonical_service,version.profile_id,change.old_value,change.new_value,change.unit,version.version_no,version.status,approver.email approver,version.approved_at,active.activated_at
FROM tender.configuration_active_parameters active
JOIN tender.configuration_changes change ON change.id=active.change_id
JOIN tender.configuration_versions version ON version.id=active.version_id
JOIN tender.enterprise_company_links company ON company.company_id=active.company_id
JOIN iam.users approver ON approver.id=version.approved_by
WHERE active.company_id='$company_id'::uuid AND active.service_line='$service_line' AND active.parameter_key='C11';"
printf 'PASS: C11=0.50 EUR_PER_HOUR was atomically activated only for WB-Cleaning/cleaning in the isolated clone; the prior version was retained and protected business data remained identical.\n'
