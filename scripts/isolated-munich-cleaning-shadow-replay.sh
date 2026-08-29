#!/usr/bin/env bash
set -Eeuo pipefail

: "${EXPECTED_COMMIT:?EXPECTED_COMMIT is required}"
container=${RESTORE_CONTAINER:-wb-tender-restore-verify-20260828T211025Z-db}
database=${RESTORE_DATABASE:-wb_platform_restore}
database_user=${RESTORE_DATABASE_USER:-restore_admin}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(git -C "$script_dir/.." rev-parse --show-toplevel)
expected_tree=${EXPECTED_TREE:-}
tender_id='2203e521-6be7-4760-a15e-1357f833b279'
company_id='15c3c602-aa51-4dd4-adc1-3586dc82e523'
lot_key='LOT-0000'
lot_id='cff860c3-27fb-48b3-96b9-86c4c3a8735d'
enrichment_version='f00be7ac-3de5-487b-b867-fe859e45c14a'

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

scalar() {
  docker exec -e 'PGOPTIONS=-c default_transaction_read_only=on' "$container" \
    psql -U "$database_user" -d "$database" -X -A -t -v ON_ERROR_STOP=1 -c "$1"
}

fingerprint() {
  scalar "SELECT concat_ws('|',
    (SELECT count(*) FROM tender.tenders),
    (SELECT count(*) FROM tender.enrichment_documents),
    (SELECT count(*) FROM tender.enrichment_fields),
    (SELECT count(*) FROM tender.calculations),
    (SELECT count(*) FROM tender.management_outputs),
    (SELECT count(*) FROM tender.calculation_input_snapshots),
    (SELECT count(*) FROM tender.configuration_active_parameters),
    (SELECT count(*) FROM tender.external_action_receipts),
    (SELECT count(*) FROM app.schema_migrations WHERE version='0155-c23-canonical-calculation-contract'),
    (SELECT count(*) FROM app.schema_migrations WHERE version='0156-c11-hourly-material-contract')
  )"
}

printf '===== SOURCE IDENTITY =====\n'
actual_commit=$(git -C "$root" rev-parse HEAD)
actual_tree=$(git -C "$root" rev-parse 'HEAD^{tree}')
printf 'commit=%s\ntree=%s\n' "$actual_commit" "$actual_tree"
test "$actual_commit" = "$EXPECTED_COMMIT" || fail "source commit mismatch: expected=$EXPECTED_COMMIT actual=$actual_commit"
if [[ -n "$expected_tree" ]]; then
  test "$actual_tree" = "$expected_tree" || fail "source tree mismatch: expected=$expected_tree actual=$actual_tree"
fi
test -z "$(git -C "$root" status --porcelain)" || fail "source checkout is dirty"

printf '\n===== ISOLATED CLONE PREFLIGHT =====\n'
command -v node
command -v docker
test "$(docker inspect -f '{{.State.Running}}' "$container")" = true || fail "restore clone is not running"
published=$(docker inspect -f '{{range $port,$bindings := .NetworkSettings.Ports}}{{if $bindings}}{{$port}}={{json $bindings}}{{end}}{{end}}' "$container")
test -z "$published" || fail "restore clone publishes host ports: $published"
docker inspect -f 'container={{.Name}} image={{.Config.Image}} networks={{range $name,$value := .NetworkSettings.Networks}}{{$name}} {{end}}mounts={{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}} {{end}}' "$container"
test "$(scalar "SELECT count(*) FROM app.schema_migrations WHERE version='0155-c23-canonical-calculation-contract'")" = 1 || fail "migration 155 candidate state is absent"
test "$(scalar "SELECT count(*) FROM app.schema_migrations WHERE version='0156-c11-hourly-material-contract'")" = 1 || fail "migration 156 candidate state is absent"

source_chain=$(scalar "SELECT count(*) FROM tender.tenders source JOIN tender.current_service_relevance relevance ON relevance.tender_id=source.id AND relevance.company_id='$company_id'::uuid AND relevance.service_line='cleaning' AND relevance.lot_key='$lot_key' JOIN tender.lots lot ON lot.id='$lot_id'::uuid AND lot.tender_id=source.id AND lot.external_id=relevance.lot_key JOIN tender.enrichment_context_bindings binding ON binding.tender_id=source.id AND binding.company_id=relevance.company_id AND binding.lot_id=lot.id AND binding.source_lot_id=relevance.lot_key AND binding.enrichment_version_id='$enrichment_version'::uuid WHERE source.id='$tender_id'::uuid AND source.external_id='552392-2026' AND source.source_lifecycle_status='ACTIVE' AND relevance.relevance_status='RELEVANT' AND relevance.service_scope_gate='PASSED' AND relevance.primary_company=true")
test "$source_chain" = 1 || fail "exact Munich source chain is not unique: $source_chain"

selected_enrichment_lot_id=$(scalar "SELECT id FROM tender.enrichment_lots WHERE enrichment_version_id='$enrichment_version'::uuid AND lot_key='$lot_key' ORDER BY id")
test "$(printf '%s\n' "$selected_enrichment_lot_id" | sed '/^$/d' | wc -l)" -eq 1 || fail "exact Munich enrichment lot is not unique"

c22_count=$(scalar "SELECT count(*) FROM tender.configuration_active_parameters active JOIN tender.configuration_changes change ON change.id=active.change_id JOIN tender.configuration_versions version ON version.id=active.version_id WHERE active.company_id='$company_id'::uuid AND active.service_line='cleaning' AND active.parameter_key='C22' AND version.status='ACTIVE' AND change.valid_from<=current_date AND (change.valid_until IS NULL OR change.valid_until>=current_date)")
test "$c22_count" = 0 || fail "C22 is persisted although only case-scoped shadow use is approved: rows=$c22_count"

c23_count=$(scalar "SELECT count(*) FROM tender.configuration_active_parameters active JOIN tender.configuration_changes change ON change.id=active.change_id JOIN tender.configuration_versions version ON version.id=active.version_id WHERE active.company_id='$company_id'::uuid AND active.service_line='cleaning' AND active.parameter_key='C23' AND change.new_value='1670'::jsonb AND change.unit='HOURS_PER_YEAR' AND version.status='ACTIVE' AND version.approved_by IS NOT NULL AND version.approved_at IS NOT NULL AND change.valid_from<=current_date AND (change.valid_until IS NULL OR change.valid_until>=current_date)")
test "$c23_count" = 1 || fail "approved exact-scope C23=1670 is not unique: rows=$c23_count"

c11_count=$(scalar "SELECT count(*) FROM tender.configuration_active_parameters active JOIN tender.configuration_changes change ON change.id=active.change_id JOIN tender.configuration_versions version ON version.id=active.version_id WHERE active.company_id='$company_id'::uuid AND active.service_line='cleaning' AND active.parameter_key='C11' AND change.new_value='0.5'::jsonb AND change.unit='EUR_PER_HOUR' AND change.source='Vorstandsfreigabe Dr. Ingo Wissmann vom 29.08.2026' AND version.status='ACTIVE' AND version.approved_by='fe93f980-5699-44f4-ad41-69d254dcaa9f'::uuid AND version.approved_at IS NOT NULL AND change.valid_from='2026-08-29'::date AND change.valid_until IS NULL")
test "$c11_count" = 1 || fail "approved exact-scope C11=0.50 EUR_PER_HOUR is not unique: rows=$c11_count"

before=$(fingerprint)
printf 'before_fingerprint=%s\n' "$before"

temporary=$(mktemp -d)
documents_file="$temporary/documents.json"
parameters_file="$temporary/parameters.json"
metadata_file="$temporary/metadata.json"
cleanup() {
  rm -f "$documents_file" "$parameters_file" "$metadata_file"
  rmdir "$temporary" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

scalar "SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id',document.id,
  'lot_id',document.lot_id,
  'filename',document.filename,
  'fetch_status',document.fetch_status,
  'document_type',document.document_type,
  'procurement_verification_status',document.procurement_verification_status,
  'tender_association_verified',document.tender_association_verified,
  'lot_association_verified',document.lot_association_verified,
  'payload_sha256',document.payload_sha256,
  'provenance',document.provenance,
  'extracted_data',document.extracted_data
) ORDER BY document.filename,document.id),'[]'::jsonb)::text
FROM tender.enrichment_documents document
WHERE document.enrichment_version_id='$enrichment_version'::uuid
  AND document.fetch_status='VORHANDEN'
  AND document.procurement_verification_status='VERIFIED'" >"$documents_file"

scalar "SELECT coalesce(jsonb_agg(to_jsonb(parameter_row) ORDER BY parameter_row.parameter_key),'[]'::jsonb)::text FROM (
  SELECT DISTINCT ON(active.parameter_key)
    active.parameter_key,
    change.new_value,
    change.unit,
    change.source,
    active.version_id,
    active.activated_at,
    active.activated_by,
    version.version_no,
    version.tenant_id,
    version.profile_id,
    version.approved_by,
    version.approved_at
  FROM tender.configuration_active_parameters active
  JOIN tender.configuration_changes change ON change.id=active.change_id
  JOIN tender.configuration_versions version
    ON version.id=active.version_id
   AND version.company_id=active.company_id
   AND version.canonical_service='cleaning'
  JOIN tender.configuration_scopes scope
    ON scope.tenant_id=version.tenant_id
   AND scope.company_id=version.company_id
   AND scope.canonical_service=version.canonical_service
   AND scope.profile_id=version.profile_id
  WHERE active.company_id='$company_id'::uuid
    AND active.service_line='cleaning'
    AND active.parameter_key~'^C(0[1-9]|1[0-9]|2[0-3])$'
    AND version.status='ACTIVE'
    AND version.approved_by IS NOT NULL
    AND version.approved_at IS NOT NULL
    AND change.valid_from<=current_date
    AND (change.valid_until IS NULL OR change.valid_until>=current_date)
  ORDER BY active.parameter_key,version.version_no DESC,active.activated_at DESC
) parameter_row" >"$parameters_file"

scalar "SELECT jsonb_build_object(
  'tender',jsonb_build_object('id',source.id,'externalId',source.external_id,'title',source.title,'buyer',source.buyer,'offerDeadline',source.offer_deadline),
  'company',jsonb_build_object('id',company.company_id,'legalName',company.legal_name,'sectorSlug',company.sector_slug),
  'lot',jsonb_build_object('id',lot.id,'key',lot.external_id,'enrichmentVersionId','$enrichment_version','enrichmentVersion',enrichment.version),
  'shadowTimestamp',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
)::text
FROM tender.tenders source
JOIN tender.enterprise_company_links company ON company.company_id='$company_id'::uuid
JOIN tender.lots lot ON lot.id='$lot_id'::uuid AND lot.tender_id=source.id
JOIN tender.enrichment_versions enrichment ON enrichment.id='$enrichment_version'::uuid AND enrichment.tender_id=source.id
WHERE source.id='$tender_id'::uuid" >"$metadata_file"

printf '\n===== READ-ONLY MUNICH EVIDENCE INVENTORY =====\n'
docker exec -i -e 'PGOPTIONS=-c default_transaction_read_only=on' "$container" \
  psql -U "$database_user" -d "$database" -X -v ON_ERROR_STOP=1 -P pager=off <<WB_SQL
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout='180s';
SET LOCAL lock_timeout='5s';

SELECT document.id,document.lot_id,document.filename,document.mime_type,
       document.procurement_verification_status,document.payload_sha256,
       coalesce(jsonb_array_length(document.extracted_data->'worksheets'),0) AS worksheets,
       coalesce(jsonb_array_length(document.extracted_data->'pages'),0) AS pages
FROM tender.enrichment_documents document
WHERE document.enrichment_version_id='$enrichment_version'::uuid
  AND document.fetch_status='VORHANDEN'
  AND document.procurement_verification_status='VERIFIED'
ORDER BY document.filename,document.id;

SELECT field.id,field.lot_id,field.field_key,field.quality_status,
       left(field.value::text,240) AS value,
       field.provenance->>'parser' AS parser,
       field.provenance->>'selectedLotId' AS selected_lot_id
FROM tender.enrichment_fields field
WHERE field.enrichment_version_id='$enrichment_version'::uuid
ORDER BY field.field_key,field.created_at,field.id;

SELECT active.parameter_key,change.new_value,change.unit,version.version_no,
       version.status,approver.email AS approved_by,version.approved_at,active.activated_at
FROM tender.configuration_active_parameters active
JOIN tender.configuration_changes change ON change.id=active.change_id
JOIN tender.configuration_versions version ON version.id=active.version_id
LEFT JOIN iam.users approver ON approver.id=version.approved_by
WHERE active.company_id='$company_id'::uuid
  AND active.service_line='cleaning'
  AND active.parameter_key~'^C(0[1-9]|1[0-9]|2[0-3])$'
ORDER BY active.parameter_key,version.version_no DESC;

SELECT calculation.id,calculation.version,calculation.status,calculation.created_at,
       calculation.blocked_reasons,
       calculation.totals->>'schemaVersion' AS engine_schema,
       calculation.totals->>'productiveHours' AS productive_hours,
       calculation.totals->>'hoursPerYear' AS annual_hours,
       calculation.totals->>'hoursPerMonth' AS monthly_hours,
       calculation.totals->>'fte' AS fte,
       calculation.totals->>'fteAnnualHours' AS fte_annual_hours,
       calculation.totals->>'externalTransmission' AS external_transmission
FROM tender.calculations calculation
WHERE calculation.tender_id='$tender_id'::uuid
  AND calculation.company_id='$company_id'::uuid
  AND calculation.lot_key='$lot_key'
ORDER BY calculation.version DESC,calculation.created_at DESC,calculation.id DESC;

SELECT input.id,input.field_key,input.value,input.unit,input.version,input.active,
       input.created_at,creator.email AS created_by
FROM tender.calculation_user_inputs input
LEFT JOIN iam.users creator ON creator.id=input.created_by
WHERE input.tender_id='$tender_id'::uuid
  AND input.company_id='$company_id'::uuid
  AND input.lot_key='$lot_key'
ORDER BY input.field_key,input.version DESC,input.created_at DESC;

ROLLBACK;
WB_SQL

printf '\n===== EXACT NONPERSISTENT MUNICH SHADOW =====\n'
node "$root/scripts/isolated-munich-cleaning-shadow.mjs" \
  "$documents_file" "$parameters_file" "$metadata_file" "$selected_enrichment_lot_id"

after=$(fingerprint)
printf 'after_fingerprint=%s\n' "$after"
test "$before" = "$after" || fail "protected clone fingerprint changed"
printf 'persisted_C22_rows=%s\n' "$c22_count"
printf 'approved_C23_rows=%s\n' "$c23_count"
printf 'approved_C11_rows=%s\n' "$c11_count"
printf 'PASS: Munich Cleaning schema-5 shadow matched all accepted workforce and C11 values; C22 remained case-scoped and nonpersistent, C23 and C11 came from approved exact scopes, conditional C13/C14 omissions stayed explicit, management output stayed internal, and the isolated clone remained unchanged.\n'
