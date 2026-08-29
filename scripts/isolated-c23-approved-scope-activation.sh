#!/usr/bin/env bash
set -Eeuo pipefail

: "${EXPECTED_COMMIT:?EXPECTED_COMMIT is required}"

container=${RESTORE_CONTAINER:-wb-tender-restore-verify-20260828T211025Z-db}
database=${RESTORE_DATABASE:-wb_platform_restore}
database_user=${RESTORE_DATABASE_USER:-restore_admin}
approved_value=1670
approved_unit=HOURS_PER_YEAR
approval_date=2026-08-29
approval_actor_email=admin@wb-tender.de

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(git -C "$script_dir/.." rev-parse --show-toplevel)

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

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
    (SELECT count(*) FROM tender.configuration_active_parameters WHERE parameter_key='C23')
  )"
}

printf '===== SOURCE AND CLONE GATE =====\n'
actual_commit=$(git -C "$root" rev-parse HEAD)
actual_tree=$(git -C "$root" rev-parse HEAD^{tree})
test "$actual_commit" = "$EXPECTED_COMMIT" || fail "source commit mismatch: expected=$EXPECTED_COMMIT actual=$actual_commit"
test -z "$(git -C "$root" status --porcelain)" || fail "source checkout is dirty"
test "$(docker inspect -f '{{.State.Running}}' "$container")" = true || fail "isolated clone is not running"
published=$(docker inspect -f '{{range $port,$bindings := .NetworkSettings.Ports}}{{if $bindings}}{{$port}}={{json $bindings}}{{end}}{{end}}' "$container")
test -z "$published" || fail "isolated clone publishes host ports: $published"
test "$(scalar 'SELECT current_database()')" = "$database" || fail "restore database identity mismatch"
test "$database" = wb_platform_restore || fail "refusing non-restore database: $database"
test "$(scalar "SELECT count(*) FROM app.schema_migrations WHERE version='0155-c23-canonical-calculation-contract'")" = 1 || fail "migration 155 candidate state is absent"
test "$(scalar "SELECT count(*) FROM pg_proc WHERE oid=to_regprocedure('digest(bytea,text)')")" = 1 || fail "required SHA-256 digest function is absent"
printf 'commit=%s\ntree=%s\ncontainer=%s\ndatabase=%s\n' "$actual_commit" "$actual_tree" "$container" "$database"

printf '\n===== EXACT SCOPE AND ACTOR GATES =====\n'
scope_match=$(scalar "WITH expected(tenant_id,company_id,canonical_service,profile_id,service_line) AS (VALUES
  ('1df0552d-34e0-4bc6-8205-e1fae02a90de'::uuid,'15c3c602-aa51-4dd4-adc1-3586dc82e523'::uuid,'cleaning','447c8ef1-39e2-4ec0-a053-0dadd5b01e0b'::uuid,'cleaning'),
  ('1df0552d-34e0-4bc6-8205-e1fae02a90de'::uuid,'5af13cd4-5403-45bc-a3bb-8bf21803da98'::uuid,'emergency_services','bc8219b6-24c5-43e7-a336-54f72b45b9c8'::uuid,'emergency-services'),
  ('1df0552d-34e0-4bc6-8205-e1fae02a90de'::uuid,'f85c04b9-661c-4271-a493-637cda27b09b'::uuid,'facility_management','ead40eff-0721-4266-81ff-f141b28cc442'::uuid,'facility-management'),
  ('1df0552d-34e0-4bc6-8205-e1fae02a90de'::uuid,'b8bc1f97-60cb-4c5d-b42a-d31d44839c5a'::uuid,'security','b3a0ef3d-3347-4fc0-b166-f3afa4d05d25'::uuid,'security'),
  ('1df0552d-34e0-4bc6-8205-e1fae02a90de'::uuid,'7edf1812-b5e9-4b5c-addf-95d2339362b3'::uuid,'security','47496a61-2a4c-49e5-a8a2-7c9793d4f054'::uuid,'security'),
  ('1df0552d-34e0-4bc6-8205-e1fae02a90de'::uuid,'08dd8151-c950-4975-aa75-e882bdcf395c'::uuid,'sicherheitstechnik','2dbd02a0-c5be-4ca6-983f-7db2fa7b73a0'::uuid,'sicherheitstechnik')
), actual AS (
  SELECT tenant_id,company_id,canonical_service,profile_id,
    CASE canonical_service WHEN 'facility_management' THEN 'facility-management' WHEN 'emergency_services' THEN 'emergency-services' ELSE canonical_service END service_line
  FROM tender.configuration_scopes
)
SELECT CASE WHEN
  (SELECT count(*) FROM expected)=6 AND
  NOT EXISTS(SELECT * FROM expected EXCEPT SELECT * FROM actual) AND
  NOT EXISTS(SELECT * FROM actual EXCEPT SELECT * FROM expected)
THEN 1 ELSE 0 END")
test "$scope_match" = 1 || fail "active configuration scopes differ from the six approved scopes"

actor_count=$(scalar "SELECT count(*) FROM iam.users user_row
  WHERE lower(user_row.email)=lower('$approval_actor_email') AND user_row.active=true
    AND EXISTS(SELECT 1 FROM iam.user_roles user_role JOIN iam.role_permissions role_permission ON role_permission.role_id=user_role.role_id JOIN iam.permissions permission_row ON permission_row.id=role_permission.permission_id WHERE user_role.user_id=user_row.id AND permission_row.code='tender.config.self_approve_activate')")
test "$actor_count" = 1 || fail "expected exactly one active board self-approval actor for $approval_actor_email; found $actor_count"
printf 'approved_scopes=6\napproval_actor=%s\napproved_C23=%s\napproved_unit=%s\napproval_date=%s\n' "$approval_actor_email" "$approved_value" "$approved_unit" "$approval_date"

existing_total=$(scalar "SELECT count(*) FROM tender.configuration_active_parameters WHERE parameter_key='C23'")
existing_exact=$(scalar "SELECT count(*) FROM tender.configuration_active_parameters active JOIN tender.configuration_changes change ON change.id=active.change_id JOIN tender.configuration_versions version ON version.id=active.version_id WHERE active.parameter_key='C23' AND change.new_value='1670'::jsonb AND change.unit='HOURS_PER_YEAR' AND version.status='ACTIVE' AND version.approved_by IS NOT NULL AND version.approved_at IS NOT NULL")
if [[ "$existing_total" = 6 && "$existing_exact" = 6 ]]; then
  printf 'PASS: all six approved C23 values are already active in the isolated clone; rerun is idempotent and made no changes.\n'
  exit 0
fi
test "$existing_total" = 0 || fail "refusing partial or conflicting C23 state: total=$existing_total exact=$existing_exact"

before_protected=$(protected_fingerprint)
before_configuration=$(configuration_fingerprint)
printf 'before_protected=%s\nbefore_configuration=%s\n' "$before_protected" "$before_configuration"

printf '\n===== ATOMIC ISOLATED C23 ACTIVATION =====\n'
docker exec -i "$container" psql -U "$database_user" -d "$database" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';

DO $activation$
DECLARE
  actor_id uuid;
  scope_row record;
  predecessor_id uuid;
  version_id uuid;
  version_no_value bigint;
  change_id uuid;
  payload_value jsonb;
  metadata_value jsonb;
BEGIN
  IF current_database()<>'wb_platform_restore' THEN
    RAISE EXCEPTION 'refusing_non_restore_database_%',current_database();
  END IF;

  SELECT user_row.id INTO STRICT actor_id
  FROM iam.users user_row
  WHERE lower(user_row.email)='admin@wb-tender.de'
    AND user_row.active=true
    AND EXISTS(
      SELECT 1
      FROM iam.user_roles user_role
      JOIN iam.role_permissions role_permission ON role_permission.role_id=user_role.role_id
      JOIN iam.permissions permission_row ON permission_row.id=role_permission.permission_id
      WHERE user_role.user_id=user_row.id
        AND permission_row.code='tender.config.self_approve_activate'
    );

  IF EXISTS(SELECT 1 FROM tender.configuration_active_parameters WHERE parameter_key='C23') THEN
    RAISE EXCEPTION 'C23_active_state_must_be_empty';
  END IF;

  FOR scope_row IN
    SELECT expected.*
    FROM (VALUES
      ('1df0552d-34e0-4bc6-8205-e1fae02a90de'::uuid,'15c3c602-aa51-4dd4-adc1-3586dc82e523'::uuid,'cleaning','447c8ef1-39e2-4ec0-a053-0dadd5b01e0b'::uuid,'cleaning','WB-Cleaning GmbH'),
      ('1df0552d-34e0-4bc6-8205-e1fae02a90de'::uuid,'5af13cd4-5403-45bc-a3bb-8bf21803da98'::uuid,'emergency_services','bc8219b6-24c5-43e7-a336-54f72b45b9c8'::uuid,'emergency-services','WB-Emergency Service GmbH'),
      ('1df0552d-34e0-4bc6-8205-e1fae02a90de'::uuid,'f85c04b9-661c-4271-a493-637cda27b09b'::uuid,'facility_management','ead40eff-0721-4266-81ff-f141b28cc442'::uuid,'facility-management','WB-Facilitys GmbH'),
      ('1df0552d-34e0-4bc6-8205-e1fae02a90de'::uuid,'b8bc1f97-60cb-4c5d-b42a-d31d44839c5a'::uuid,'security','b3a0ef3d-3347-4fc0-b166-f3afa4d05d25'::uuid,'security','WB-Protect & Service GmbH'),
      ('1df0552d-34e0-4bc6-8205-e1fae02a90de'::uuid,'7edf1812-b5e9-4b5c-addf-95d2339362b3'::uuid,'security','47496a61-2a4c-49e5-a8a2-7c9793d4f054'::uuid,'security','WB-Security GmbH'),
      ('1df0552d-34e0-4bc6-8205-e1fae02a90de'::uuid,'08dd8151-c950-4975-aa75-e882bdcf395c'::uuid,'sicherheitstechnik','2dbd02a0-c5be-4ca6-983f-7db2fa7b73a0'::uuid,'sicherheitstechnik','WB-Sicherheitstechnik GmbH')
    ) AS expected(tenant_id,company_id,canonical_service,profile_id,service_line,legal_name)
    JOIN tender.configuration_scopes actual
      ON actual.tenant_id=expected.tenant_id
     AND actual.company_id=expected.company_id
     AND actual.canonical_service=expected.canonical_service
     AND actual.profile_id=expected.profile_id
    ORDER BY expected.legal_name
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext('configuration-active:'||scope_row.company_id::text||':'||scope_row.service_line));

    SELECT id INTO predecessor_id
    FROM tender.configuration_versions
    WHERE tenant_id=scope_row.tenant_id
      AND company_id=scope_row.company_id
      AND canonical_service=scope_row.canonical_service
      AND profile_id=scope_row.profile_id
      AND service_line=scope_row.service_line
    ORDER BY version_no DESC
    LIMIT 1
    FOR SHARE;

    payload_value=jsonb_build_object(
      'clientRequestId',gen_random_uuid()::text,
      'businessApprovalId','WB-C23-1670-20260829',
      'tenantId',scope_row.tenant_id,
      'companyId',scope_row.company_id,
      'serviceLine',scope_row.service_line,
      'canonicalService',scope_row.canonical_service,
      'profileId',scope_row.profile_id,
      'source','Vorstandsfreigabe Dr. Ingo Wissmann vom 29.08.2026',
      'reason','1.670 produktive Jahresstunden je Vollzeitkraft als gesellschafts- und leistungsscharfer Geschäftswert'
    );

    INSERT INTO tender.configuration_versions(
      predecessor_id,company_id,service_line,tenant_id,canonical_service,profile_id,
      source,reason,payload,checksum,created_by,status
    ) VALUES (
      predecessor_id,scope_row.company_id,scope_row.service_line,scope_row.tenant_id,
      scope_row.canonical_service,scope_row.profile_id,
      'Vorstandsfreigabe Dr. Ingo Wissmann vom 29.08.2026',
      '1.670 produktive Jahresstunden je Vollzeitkraft als produktiver Geschäftswert',
      payload_value,
      encode(digest(convert_to(payload_value::text,'UTF8'),'sha256'),'hex'),
      actor_id,'DRAFT'
    ) RETURNING id,version_no INTO version_id,version_no_value;

    INSERT INTO tender.configuration_changes(
      version_id,category,parameter_key,old_value,new_value,unit,source,data_as_of,
      valid_from,valid_until,priority,complete,justification
    ) VALUES (
      version_id,'CALCULATION','C23',NULL,'1670'::jsonb,'HOURS_PER_YEAR',
      'Vorstandsfreigabe Dr. Ingo Wissmann vom 29.08.2026','2026-08-29'::date,
      '2026-08-29'::date,NULL,'C',false,
      'Produktive Jahresstunden ohne technischen Fallback; für alle sechs aktiven WB-Scope-Kombinationen freigegeben'
    ) RETURNING id INTO change_id;

    INSERT INTO tender.configuration_audit(version_id,actor_id,action,metadata)
    VALUES
      (version_id,actor_id,'DRAFT_CREATED',jsonb_build_object('businessApprovalId','WB-C23-1670-20260829','parameterKey','C23')),
      (version_id,actor_id,'CHANGE_SAVED',jsonb_build_object('parameterKey','C23','value',1670,'unit','HOURS_PER_YEAR'));

    UPDATE tender.configuration_versions
    SET status='APPROVED',
        validation=jsonb_build_object('valid',true,'errors',jsonb_build_array(),'checkedAt',clock_timestamp()),
        submitted_at=now(),approved_at=now(),approved_by=actor_id
    WHERE id=version_id AND status='DRAFT';

    INSERT INTO tender.configuration_active_parameters(
      company_id,service_line,parameter_key,version_id,change_id,activated_at,activated_by
    ) VALUES (
      scope_row.company_id,scope_row.service_line,'C23',version_id,change_id,now(),actor_id
    );

    UPDATE tender.configuration_versions
    SET status='ACTIVE',activated_at=now()
    WHERE id=version_id;

    metadata_value=jsonb_build_object(
      'notice','Selbstfreigabe aufgrund ausdrücklicher Vorstandsberechtigung',
      'businessApprovalId','WB-C23-1670-20260829',
      'creatorId',actor_id,
      'approverId',actor_id,
      'activatorId',actor_id,
      'companyId',scope_row.company_id,
      'company',scope_row.legal_name,
      'serviceLine',scope_row.service_line,
      'canonicalService',scope_row.canonical_service,
      'profileId',scope_row.profile_id,
      'versionNo',version_no_value,
      'parameterKey','C23',
      'value',1670,
      'unit','HOURS_PER_YEAR'
    );

    INSERT INTO tender.configuration_audit(version_id,actor_id,action,metadata)
    VALUES
      (version_id,actor_id,'BOARD_SELF_APPROVED',metadata_value),
      (version_id,actor_id,'ACTIVE',metadata_value);
  END LOOP;

  IF (SELECT count(*) FROM tender.configuration_active_parameters active
      JOIN tender.configuration_changes change ON change.id=active.change_id
      JOIN tender.configuration_versions version ON version.id=active.version_id
      WHERE active.parameter_key='C23'
        AND change.new_value='1670'::jsonb
        AND change.unit='HOURS_PER_YEAR'
        AND change.valid_from='2026-08-29'::date
        AND change.valid_until IS NULL
        AND version.status='ACTIVE'
        AND version.approved_by=actor_id
        AND version.approved_at IS NOT NULL)=6 THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'C23_exact_activation_postcondition_failed';
  END IF;
END
$activation$;

COMMIT;
SQL

after_protected=$(protected_fingerprint)
after_configuration=$(configuration_fingerprint)
test "$after_protected" = "$before_protected" || fail "protected business fingerprint changed: before=$before_protected after=$after_protected"

IFS='|' read -r before_versions before_changes before_active before_audit before_c23 <<<"$before_configuration"
IFS='|' read -r after_versions after_changes after_active after_audit after_c23 <<<"$after_configuration"
test "$after_versions" -eq $((before_versions+6)) || fail "configuration version delta is not +6"
test "$after_changes" -eq $((before_changes+6)) || fail "configuration change delta is not +6"
test "$after_active" -eq $((before_active+6)) || fail "active parameter delta is not +6"
test "$after_audit" -eq $((before_audit+24)) || fail "configuration audit delta is not +24"
test "$after_c23" -eq 6 || fail "active C23 count is not 6"

printf 'after_protected=%s\nafter_configuration=%s\n' "$after_protected" "$after_configuration"
docker exec -e 'PGOPTIONS=-c default_transaction_read_only=on' "$container" psql -U "$database_user" -d "$database" -X -P pager=off -v ON_ERROR_STOP=1 -c "
SELECT company.legal_name,scope.canonical_service,scope.profile_id,change.new_value,change.unit,version.version_no,version.status,approver.email approver,version.approved_at,active.activated_at
FROM tender.configuration_active_parameters active
JOIN tender.configuration_changes change ON change.id=active.change_id
JOIN tender.configuration_versions version ON version.id=active.version_id
JOIN tender.configuration_scopes scope ON scope.tenant_id=version.tenant_id AND scope.company_id=version.company_id AND scope.canonical_service=version.canonical_service AND scope.profile_id=version.profile_id
JOIN tender.enterprise_company_links company ON company.company_id=active.company_id
JOIN iam.users approver ON approver.id=version.approved_by
WHERE active.parameter_key='C23'
ORDER BY company.legal_name;"

printf 'PASS: C23=1670 HOURS_PER_YEAR was atomically activated only in the isolated clone for all six exact approved scopes; protected business data remained identical.\n'
