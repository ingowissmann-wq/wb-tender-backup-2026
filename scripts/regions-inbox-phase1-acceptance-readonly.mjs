import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const connectionString = process.env.DATABASE_URL
  || readFileSync(process.env.DATABASE_URL_FILE || "/run/secrets/database_url", "utf8").trim();
const pool = new pg.Pool({
  connectionString,
  max: 1,
  options: "-c default_transaction_read_only=on -c statement_timeout=55000",
});
const statuses = [
  "CORE_REGION",
  "STRATEGIC_REGION",
  "OUTSIDE_CORE_REGION",
  "EXCLUDED_REGION",
  "REGION_UNRESOLVED",
  "REGION_CONFIG_CONFLICT",
  "MULTI_REGION_REVIEW",
  "REGION_CONFIGURATION_MISSING",
  "NOT_APPLICABLE",
];
const client = await pool.connect();

try {
  await client.query("BEGIN READ ONLY");
  const tenant = (await client.query("SELECT id FROM tender.configuration_tenants WHERE tenant_key='WB_INTERNAL_TENDER'")).rows[0];
  if (!tenant) throw new Error("authoritative_configuration_tenant_missing");
  const backgroundScope = (await client.query("SELECT tenant_id,company_id FROM tender.resolve_background_scope() ORDER BY tenant_id,company_id")).rows;
  if (!backgroundScope.length) throw new Error("authoritative_background_scope_missing");
  await client.query("SELECT set_config('app.configuration_tenant_id',$1,true),set_config('app.tenant_ids',$2,true),set_config('app.tenant_id',$3,true),set_config('app.company_ids',$4,true)", [
    tenant.id,
    [...new Set(backgroundScope.map((row) => row.tenant_id))].join(","),
    [...new Set(backgroundScope.map((row) => row.tenant_id))].length===1?backgroundScope[0].tenant_id:"",
    [...new Set(backgroundScope.map((row) => row.company_id))].join(","),
  ]);
  const scopeDiagnostics = (await client.query(`SELECT
    cardinality(tender.runtime_uuid_list('app.tenant_ids')) runtime_tenant_count,
    cardinality(tender.runtime_uuid_list('app.company_ids')) runtime_company_count,
    (SELECT count(*)::int FROM tender.configuration_scopes) configuration_scopes,
    (SELECT count(*)::int FROM tender.enterprise_company_links) companies,
    (SELECT count(*)::int FROM tender.enterprise_company_links WHERE active=true) active_companies,
    (SELECT count(*)::int FROM tender.configuration_scopes scope JOIN tender.enterprise_company_links company ON company.company_id=scope.company_id) scope_company_links,
    (SELECT count(*)::int FROM tender.configuration_scopes scope JOIN tender.enterprise_company_links company ON company.company_id=scope.company_id AND company.tender_profile_id=scope.profile_id) exact_profile_links,
    (SELECT jsonb_agg(jsonb_build_object('name',policyname,'qual',qual) ORDER BY policyname) FROM pg_policies WHERE schemaname='tender' AND tablename='enterprise_company_links') company_policies`)).rows[0];
  const rows = (await client.query(`WITH active_scope AS(
      SELECT scope.*,company.legal_name,
        CASE scope.canonical_service WHEN 'facility_management' THEN 'facility-management' WHEN 'emergency_services' THEN 'emergency-services' ELSE scope.canonical_service END service_line,
        active_version.id active_configuration_version_id
      FROM tender.configuration_scopes scope
      JOIN tender.enterprise_company_links company ON company.company_id=scope.company_id AND company.tender_profile_id=scope.profile_id AND company.active=true
      LEFT JOIN tender.configuration_active_parameters active ON active.company_id=scope.company_id AND active.parameter_key='A08'
        AND (CASE active.service_line WHEN 'facility-management' THEN 'facility_management' WHEN 'emergency-services' THEN 'emergency_services' ELSE active.service_line END)=scope.canonical_service
      LEFT JOIN tender.configuration_versions active_version ON active_version.id=active.version_id
        AND active_version.tenant_id=scope.tenant_id AND active_version.company_id=scope.company_id
        AND active_version.canonical_service=scope.canonical_service AND active_version.profile_id=scope.profile_id AND active_version.status='ACTIVE'
    ), relevance AS(
      SELECT relevance.*,scope.tenant_id,scope.canonical_service,scope.profile_id,scope.active_region_version_id,
        scope.active_configuration_version_id,scope.legal_name
      FROM tender.service_relevance_evaluations relevance
      JOIN active_scope scope ON scope.company_id=relevance.company_id AND scope.service_line=relevance.service_line
      WHERE relevance.relevance_status IN('RELEVANT','POTENTIALLY_RELEVANT') AND relevance.primary_company=true
        AND NOT EXISTS(SELECT 1 FROM tender.service_relevance_evaluations newer
          WHERE newer.tender_id=relevance.tender_id AND newer.company_id=relevance.company_id
            AND newer.lot_key IS NOT DISTINCT FROM relevance.lot_key AND newer.evaluation_version>relevance.evaluation_version)
    ), latest_region AS MATERIALIZED(
      SELECT DISTINCT ON(evaluation.tender_id,evaluation.company_id,evaluation.lot_id,evaluation.tenant_id,evaluation.canonical_service,evaluation.profile_id,evaluation.region_profile_version_id,evaluation.configuration_version_id) evaluation.*
      FROM active_scope scope JOIN tender.region_evaluations evaluation
        ON evaluation.tenant_id=scope.tenant_id AND evaluation.company_id=scope.company_id
        AND evaluation.canonical_service=scope.canonical_service AND evaluation.profile_id=scope.profile_id
        AND evaluation.region_profile_version_id=scope.active_region_version_id
        AND evaluation.configuration_version_id=scope.active_configuration_version_id
      WHERE scope.active_region_version_id IS NOT NULL AND scope.active_configuration_version_id IS NOT NULL
      ORDER BY evaluation.tender_id,evaluation.company_id,evaluation.lot_id,evaluation.tenant_id,evaluation.canonical_service,evaluation.profile_id,evaluation.region_profile_version_id,evaluation.configuration_version_id,
        evaluation.evaluation_version DESC,evaluation.created_at DESC,evaluation.id DESC
    ), candidates AS(
      SELECT relevance.company_id,relevance.legal_name,relevance.canonical_service,relevance.tender_id,relevance.lot_key,
        relevance.tenant_id,relevance.profile_id,relevance.active_region_version_id,relevance.active_configuration_version_id,
        region.id region_evaluation_id,
        CASE WHEN relevance.active_region_version_id IS NULL OR relevance.active_configuration_version_id IS NULL THEN 'REGION_CONFIGURATION_MISSING'
          ELSE coalesce(region.classification,'REGION_UNRESOLVED') END classification
      FROM relevance
      JOIN tender.tenders tender ON tender.id=relevance.tender_id AND tender.data_class='PUBLIC_REAL'
        AND tender.source_lifecycle_status='ACTIVE' AND tender.participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE')
      LEFT JOIN latest_region region ON region.tender_id=relevance.tender_id AND region.company_id=relevance.company_id AND region.lot_id IS NULL
        AND region.tenant_id=relevance.tenant_id AND region.canonical_service=relevance.canonical_service AND region.profile_id=relevance.profile_id
        AND region.region_profile_version_id=relevance.active_region_version_id AND region.configuration_version_id=relevance.active_configuration_version_id
      WHERE EXISTS(SELECT 1 FROM tender.current_participation_eligible_lots eligible
        WHERE eligible.tender_id=tender.id AND (relevance.lot_key IS NULL OR eligible.lot_key=relevance.lot_key))
    )
    SELECT scope.company_id,scope.legal_name,scope.canonical_service,
      (scope.active_region_version_id IS NOT NULL AND scope.active_configuration_version_id IS NOT NULL) configured,
      count(candidate.tender_id)::int context_count,
      count(*) FILTER(WHERE candidate.classification='CORE_REGION')::int core,
      count(*) FILTER(WHERE candidate.classification='STRATEGIC_REGION')::int strategic,
      count(*) FILTER(WHERE candidate.classification='OUTSIDE_CORE_REGION')::int outside,
      count(*) FILTER(WHERE candidate.classification='EXCLUDED_REGION')::int excluded,
      count(*) FILTER(WHERE candidate.classification='REGION_UNRESOLVED')::int unresolved,
      count(*) FILTER(WHERE candidate.classification='REGION_CONFIG_CONFLICT')::int conflict,
      count(*) FILTER(WHERE candidate.classification='MULTI_REGION_REVIEW')::int multi_review,
      count(*) FILTER(WHERE candidate.classification='REGION_CONFIGURATION_MISSING')::int configuration_missing,
      count(*) FILTER(WHERE candidate.classification='NOT_APPLICABLE')::int not_applicable,
      count(*) FILTER(WHERE candidate.region_evaluation_id IS NOT NULL)::int exactly_materialized,
      encode(digest(string_agg(candidate.tender_id::text||':'||coalesce(candidate.lot_key,'')||':'||candidate.classification,'|' ORDER BY candidate.tender_id,candidate.lot_key), 'sha256'),'hex') candidate_fingerprint
    FROM active_scope scope LEFT JOIN candidates candidate
      ON candidate.tenant_id=scope.tenant_id AND candidate.company_id=scope.company_id
      AND candidate.canonical_service=scope.canonical_service AND candidate.profile_id=scope.profile_id
    GROUP BY scope.company_id,scope.legal_name,scope.canonical_service,scope.active_region_version_id,scope.active_configuration_version_id
    ORDER BY scope.legal_name`)).rows;

  const companies = rows.map((row) => {
    const counts = Object.fromEntries(statuses.map((status) => {
      const key = ({CORE_REGION:"core",STRATEGIC_REGION:"strategic",OUTSIDE_CORE_REGION:"outside",EXCLUDED_REGION:"excluded",REGION_UNRESOLVED:"unresolved",REGION_CONFIG_CONFLICT:"conflict",MULTI_REGION_REVIEW:"multi_review",REGION_CONFIGURATION_MISSING:"configuration_missing",NOT_APPLICABLE:"not_applicable"})[status];
      return [status, Number(row[key])];
    }));
    const statusSum = Object.values(counts).reduce((sum, value) => sum + value, 0);
    if (statusSum !== Number(row.context_count)) throw new Error(`${row.legal_name}: status_sum_mismatch`);
    return {
      company: row.legal_name,
      canonicalService: row.canonical_service,
      configured: row.configured,
      contextCount: Number(row.context_count),
      counts,
      statusSum,
      exactlyMaterialized: Number(row.exactly_materialized),
      candidateFingerprint: row.candidate_fingerprint,
      pageSizes: [Math.min(50, Number(row.context_count)), Math.min(50, Math.max(0, Number(row.context_count) - 50))],
    };
  });
  const policy = (await client.query(`SELECT
    (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='tender.region_evaluations'::regclass) region_evaluations_rls_forced,
    (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='tender.management_inbox'::regclass) management_inbox_rls_forced,
    (SELECT count(*)::int FROM tender.region_evaluations evaluation JOIN tender.configuration_scopes scope
      ON evaluation.company_id=scope.company_id AND evaluation.canonical_service=scope.canonical_service AND evaluation.profile_id=scope.profile_id
      AND evaluation.region_profile_version_id=scope.active_region_version_id
      WHERE evaluation.tenant_id<>scope.tenant_id) cross_tenant_binding_rows`)).rows[0];
  console.log(JSON.stringify({
    passed: true,
    readOnly: true,
    capturedAt: new Date().toISOString(),
    binding: "tenant/company/canonical_service/profile/active_region_profile_version/active_configuration_version",
    scopeDiagnostics,
    companies,
    policy,
    externalWrite: false,
    transmitted: false,
  }, null, 2));
} finally {
  await client.query("ROLLBACK").catch(() => {});
  client.release();
  await pool.end();
}
