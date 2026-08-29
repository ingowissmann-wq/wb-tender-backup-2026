#!/usr/bin/env bash
set -Eeuo pipefail

: "${EXPECTED_COMMIT:?EXPECTED_COMMIT is required}"

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
database=${RESTORE_DATABASE:-wb_platform_restore}
database_user=${RESTORE_DATABASE_USER:-restore_admin}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

scalar() {
  docker exec "$container" psql -U "$database_user" -d "$database" -X -A -t -v ON_ERROR_STOP=1 -c "$1"
}

fingerprint() {
  scalar "SELECT concat_ws('|',
    (SELECT count(*) FROM tender.tenders),
    (SELECT count(*) FROM tender.enrichment_documents),
    (SELECT count(*) FROM tender.enrichment_fields),
    (SELECT count(*) FROM tender.calculations),
    (SELECT count(*) FROM tender.region_evaluations),
    (SELECT count(*) FROM tender.configuration_active_parameters),
    (SELECT count(*) FROM tender.external_action_receipts),
    (SELECT count(*) FROM app.schema_migrations WHERE version='0155-c23-canonical-calculation-contract')
  )"
}

printf '===== SOURCE AND CLONE PREFLIGHT =====\n'
test -d "$root/.git" || fail "source is not a Git checkout: $root"
actual_commit=$(git -C "$root" rev-parse HEAD)
test "$actual_commit" = "$EXPECTED_COMMIT" || fail "source commit mismatch: expected=$EXPECTED_COMMIT actual=$actual_commit"
test -z "$(git -C "$root" status --porcelain)" || fail "source checkout is dirty"
printf 'commit=%s\ntree=%s\n' "$actual_commit" "$(git -C "$root" rev-parse HEAD^{tree})"

mapfile -t containers < <(docker ps --format '{{.Names}}' | awk '/^wb-tender-restore-verify-[0-9]{8}T[0-9]{6}Z-db$/')
test "${#containers[@]}" -eq 1 || fail "expected exactly one running isolated restore container, found ${#containers[@]}"
container=${containers[0]}
published=$(docker inspect -f '{{range $port,$bindings := .NetworkSettings.Ports}}{{if $bindings}}{{$port}}={{json $bindings}}{{end}}{{end}}' "$container")
test -z "$published" || fail "restore container publishes host ports: $published"
docker inspect -f 'container={{.Name}} image={{.Config.Image}} networks={{range $name,$value := .NetworkSettings.Networks}}{{$name}} {{end}}mounts={{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}} {{end}}' "$container"
test "$(scalar "SELECT count(*) FROM app.schema_migrations WHERE version='0155-c23-canonical-calculation-contract'")" = 1 || fail "migration 155 candidate state is absent"

before=$(fingerprint)
printf 'before_fingerprint=%s\n' "$before"

docker exec -i "$container" psql -U "$database_user" -d "$database" -X -v ON_ERROR_STOP=1 <<'WB_SQL'
\pset pager off
\set QUIET 1
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout='180s';
SET LOCAL lock_timeout='5s';
\set QUIET 0

\echo
\echo '===== EXACT CURRENT CLEANING CANDIDATES IN CONFIGURED REGIONS ====='
WITH candidates AS (
  SELECT
    relevance.tender_id,
    source.external_id,
    source.title,
    source.buyer,
    source.source_code,
    source.offer_deadline,
    relevance.company_id,
    company.legal_name,
    scope.tenant_id,
    scope.canonical_service,
    scope.profile_id,
    relevance.lot_key,
    lot.id AS lot_id,
    lot.title AS lot_title,
    relevance.evaluation_version AS relevance_version,
    relevance.relevance_status,
    relevance.service_scope_gate,
    relevance.primary_company,
    region.id AS region_evaluation_id,
    region.evaluation_version AS region_version,
    region.classification,
    region.regional_decision,
    region.matching_status,
    region.explanation,
    region.source_data,
    coalesce(lot_enrichment.id,global_enrichment.id) AS enrichment_version_id,
    coalesce(lot_enrichment.version,global_enrichment.version) AS enrichment_version,
    CASE
      WHEN lot_enrichment.id IS NOT NULL THEN 'EXACT_LOT_CONTEXT'
      WHEN global_enrichment.id IS NOT NULL THEN 'TENDER_GLOBAL'
      ELSE 'MISSING'
    END AS enrichment_binding
  FROM tender.current_service_relevance relevance
  JOIN tender.tenders source
    ON source.id=relevance.tender_id
  JOIN tender.enterprise_company_links company
    ON company.company_id=relevance.company_id
   AND company.active=true
  JOIN tender.configuration_scopes scope
    ON scope.company_id=relevance.company_id
   AND scope.canonical_service=(CASE relevance.service_line
     WHEN 'facility-management' THEN 'facility_management'
     WHEN 'emergency-services' THEN 'emergency_services'
     ELSE relevance.service_line END)
   AND scope.profile_id=company.tender_profile_id
  LEFT JOIN tender.lots lot
    ON lot.tender_id=relevance.tender_id
   AND lot.external_id=relevance.lot_key
  LEFT JOIN LATERAL (
    SELECT enrichment.id,enrichment.version
    FROM tender.enrichment_context_bindings binding
    JOIN tender.enrichment_versions enrichment
      ON enrichment.id=binding.enrichment_version_id
     AND enrichment.historical=false
    WHERE relevance.lot_key IS NOT NULL
      AND binding.tenant_id=scope.tenant_id
      AND binding.company_id=relevance.company_id
      AND binding.tender_id=relevance.tender_id
      AND binding.lot_id=lot.id
      AND binding.source_lot_id=relevance.lot_key
      AND binding.canonical_service=scope.canonical_service
    ORDER BY enrichment.version DESC,binding.created_at DESC
    LIMIT 1
  ) lot_enrichment ON true
  LEFT JOIN LATERAL (
    SELECT enrichment.id,enrichment.version
    FROM tender.enrichment_versions enrichment
    WHERE relevance.lot_key IS NULL
      AND enrichment.tender_id=relevance.tender_id
      AND enrichment.historical=false
    ORDER BY enrichment.version DESC,enrichment.created_at DESC
    LIMIT 1
  ) global_enrichment ON true
  JOIN LATERAL (
    SELECT evaluation.*
    FROM tender.region_evaluations evaluation
    WHERE evaluation.tender_id=relevance.tender_id
      AND evaluation.tenant_id=scope.tenant_id
      AND evaluation.company_id=relevance.company_id
      AND evaluation.canonical_service=scope.canonical_service
      AND evaluation.profile_id=scope.profile_id
      AND evaluation.lot_id IS NOT DISTINCT FROM lot.id
    ORDER BY evaluation.evaluation_version DESC,evaluation.created_at DESC,evaluation.id DESC
    LIMIT 1
  ) region ON true
  WHERE scope.canonical_service='cleaning'
    AND source.data_class='PUBLIC_REAL'
    AND source.source_lifecycle_status='ACTIVE'
    AND source.participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE')
    AND source.offer_deadline>now()
    AND relevance.relevance_status='RELEVANT'
    AND relevance.service_scope_gate='PASSED'
    AND relevance.primary_company=true
    AND region.classification IN('CORE_REGION','STRATEGIC_REGION')
)
SELECT
  candidate.external_id,
  candidate.tender_id,
  left(candidate.title,100) AS title,
  candidate.buyer,
  candidate.offer_deadline,
  candidate.legal_name,
  candidate.lot_key,
  candidate.lot_id,
  left(candidate.lot_title,80) AS lot_title,
  candidate.classification,
  candidate.regional_decision,
  candidate.matching_status,
  candidate.enrichment_binding,
  candidate.enrichment_version,
  documents.document_count,
  documents.verified_document_count,
  documents.present_document_count,
  documents.workbook_count,
  documents.workbook_with_extracted_sheets_count,
  documents.mime_types,
  facts.annual_area_fact_count,
  facts.contract_month_fact_count,
  facts.productive_hours_fact_count,
  calculation.status AS latest_calculation_status,
  calculation.blocked_reasons AS latest_blocked_reasons
FROM candidates candidate
LEFT JOIN LATERAL (
  SELECT
    count(*)::integer AS document_count,
    count(*) FILTER(WHERE document.procurement_verification_status='VERIFIED')::integer AS verified_document_count,
    count(*) FILTER(WHERE document.fetch_status='VORHANDEN')::integer AS present_document_count,
    count(*) FILTER(WHERE document.filename~*'\.(xlsx|ods)(\.ods)?$')::integer AS workbook_count,
    count(*) FILTER(
      WHERE document.filename~*'\.(xlsx|ods)(\.ods)?$'
        AND jsonb_typeof(document.extracted_data->'worksheets')='array'
        AND jsonb_array_length(document.extracted_data->'worksheets')>0
    )::integer AS workbook_with_extracted_sheets_count,
    string_agg(DISTINCT coalesce(document.mime_type,'<NULL>'),', ' ORDER BY coalesce(document.mime_type,'<NULL>')) AS mime_types
  FROM tender.enrichment_documents document
  WHERE document.enrichment_version_id=candidate.enrichment_version_id
) documents ON true
LEFT JOIN LATERAL (
  SELECT
    count(*) FILTER(WHERE field.field_key='annual_cleaning_area_occurrences')::integer AS annual_area_fact_count,
    count(*) FILTER(WHERE field.field_key='contract_duration_months')::integer AS contract_month_fact_count,
    count(*) FILTER(WHERE field.field_key IN('productive_hours','productive_hours_per_year'))::integer AS productive_hours_fact_count
  FROM tender.enrichment_fields field
  WHERE field.enrichment_version_id=candidate.enrichment_version_id
    AND (
      field.provenance->>'selectedLotId' IS NULL
      OR field.provenance->>'selectedLotId'=candidate.lot_id::text
    )
) facts ON true
LEFT JOIN LATERAL (
  SELECT latest.status,latest.blocked_reasons
  FROM tender.calculations latest
  WHERE latest.tender_id=candidate.tender_id
    AND latest.company_id=candidate.company_id
    AND latest.lot_key=coalesce(candidate.lot_key,'')
  ORDER BY latest.version DESC,latest.created_at DESC,latest.id DESC
  LIMIT 1
) calculation ON true
ORDER BY
  (candidate.external_id='552392-2026') DESC,
  documents.workbook_with_extracted_sheets_count DESC,
  documents.verified_document_count DESC,
  candidate.offer_deadline,
  candidate.external_id,
  candidate.lot_key;

\echo
\echo '===== KNOWN MUNICH SOURCE CHAIN ====='
SELECT
  source.external_id,
  source.id AS tender_id,
  source.source_lifecycle_status,
  source.participation_status,
  source.offer_deadline,
  relevance.company_id,
  relevance.service_line,
  relevance.lot_key,
  relevance.relevance_status,
  relevance.service_scope_gate,
  relevance.primary_company,
  lot.id AS lot_id,
  binding.enrichment_version_id,
  region.classification,
  region.regional_decision,
  region.matching_status
FROM tender.tenders source
LEFT JOIN tender.current_service_relevance relevance
  ON relevance.tender_id=source.id
 AND relevance.service_line='cleaning'
LEFT JOIN tender.enterprise_company_links company
  ON company.company_id=relevance.company_id
LEFT JOIN tender.configuration_scopes scope
  ON scope.company_id=relevance.company_id
 AND scope.canonical_service='cleaning'
 AND scope.profile_id=company.tender_profile_id
LEFT JOIN tender.lots lot
  ON lot.tender_id=source.id
 AND lot.external_id=relevance.lot_key
LEFT JOIN LATERAL (
  SELECT context.enrichment_version_id
  FROM tender.enrichment_context_bindings context
  JOIN tender.enrichment_versions enrichment
    ON enrichment.id=context.enrichment_version_id
   AND enrichment.historical=false
  WHERE context.tenant_id=scope.tenant_id
    AND context.company_id=relevance.company_id
    AND context.tender_id=source.id
    AND context.lot_id=lot.id
    AND context.source_lot_id=relevance.lot_key
    AND context.canonical_service='cleaning'
  ORDER BY enrichment.version DESC,context.created_at DESC
  LIMIT 1
) binding ON true
LEFT JOIN LATERAL (
  SELECT evaluation.classification,evaluation.regional_decision,evaluation.matching_status
  FROM tender.region_evaluations evaluation
  WHERE evaluation.tender_id=source.id
    AND evaluation.tenant_id=scope.tenant_id
    AND evaluation.company_id=relevance.company_id
    AND evaluation.canonical_service='cleaning'
    AND evaluation.profile_id=scope.profile_id
    AND evaluation.lot_id IS NOT DISTINCT FROM lot.id
  ORDER BY evaluation.evaluation_version DESC,evaluation.created_at DESC,evaluation.id DESC
  LIMIT 1
) region ON true
WHERE source.external_id='552392-2026'
ORDER BY relevance.primary_company DESC,relevance.lot_key,relevance.company_id;

\set QUIET 1
ROLLBACK;
\set QUIET 0
WB_SQL

after=$(fingerprint)
printf 'after_fingerprint=%s\n' "$after"
test "$before" = "$after" || fail "read-only inventory changed protected data: before=$before after=$after"

printf 'PASS: exact-scope Cleaning shadow candidate inventory completed read-only; protected data remained identical.\n'
