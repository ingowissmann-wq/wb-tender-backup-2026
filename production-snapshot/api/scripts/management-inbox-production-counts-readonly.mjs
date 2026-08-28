import fs from "node:fs";
import pg from "pg";

const pool = new pg.Pool({
  connectionString: fs.readFileSync(process.env.DATABASE_URL_FILE || "/run/secrets/database_url", "utf8").trim(),
  max: 1,
  options: "-c default_transaction_read_only=on -c statement_timeout=55000",
});

try {
  const rows = (await pool.query(`WITH active_scope AS(
      SELECT scope.company_id,scope.tenant_id,scope.canonical_service,scope.profile_id,company.legal_name,
        CASE scope.canonical_service WHEN 'facility_management' THEN 'facility-management' WHEN 'emergency_services' THEN 'emergency-services' ELSE scope.canonical_service END service_line
      FROM tender.configuration_scopes scope
      JOIN tender.enterprise_company_links company ON company.company_id=scope.company_id AND company.tender_profile_id=scope.profile_id
    ), current_relevance AS(
      SELECT relevance.*,scope.canonical_service,scope.legal_name
      FROM tender.service_relevance_evaluations relevance
      JOIN active_scope scope ON scope.company_id=relevance.company_id AND scope.service_line=relevance.service_line
      WHERE relevance.relevance_status IN('RELEVANT','POTENTIALLY_RELEVANT') AND relevance.primary_company=true
        AND NOT EXISTS(SELECT 1 FROM tender.service_relevance_evaluations newer
          WHERE newer.tender_id=relevance.tender_id AND newer.company_id=relevance.company_id
            AND newer.lot_key IS NOT DISTINCT FROM relevance.lot_key AND newer.evaluation_version>relevance.evaluation_version)
    ), latest_region AS(
      SELECT DISTINCT ON(evaluation.tender_id,evaluation.company_id,evaluation.lot_id) evaluation.*
      FROM tender.region_evaluations evaluation
      WHERE evaluation.source_data->>'pipelineVersion'='wb-daily-inbox-pipeline/1.0.0'
      ORDER BY evaluation.tender_id,evaluation.company_id,evaluation.lot_id,evaluation.evaluation_version DESC
    ), base AS(
      SELECT relevance.company_id,relevance.legal_name,relevance.canonical_service,coalesce(region.classification,'REGION_UNRESOLVED') classification
      FROM current_relevance relevance
      JOIN tender.tenders tender ON tender.id=relevance.tender_id AND tender.data_class='PUBLIC_REAL' AND tender.source_lifecycle_status='ACTIVE'
      LEFT JOIN latest_region region ON region.tender_id=relevance.tender_id AND region.company_id=relevance.company_id AND region.lot_id IS NULL
    )
    SELECT company_id,legal_name,canonical_service,count(*)::int total,
      count(*) FILTER(WHERE classification='CORE_REGION')::int core,
      count(*) FILTER(WHERE classification='STRATEGIC_REGION')::int strategic,
      count(*) FILTER(WHERE classification='OUTSIDE_CORE_REGION')::int outside,
      count(*) FILTER(WHERE classification='EXCLUDED_REGION')::int excluded,
      count(*) FILTER(WHERE classification='REGION_UNRESOLVED')::int unresolved,
      count(*) FILTER(WHERE classification='REGION_CONFIG_CONFLICT')::int conflict,
      count(*) FILTER(WHERE classification='MULTI_REGION_REVIEW')::int multi_review
    FROM base GROUP BY company_id,legal_name,canonical_service ORDER BY legal_name`)).rows;
  for (const row of rows) {
    const sum = Number(row.core) + Number(row.strategic) + Number(row.outside) + Number(row.excluded) + Number(row.unresolved) + Number(row.conflict) + Number(row.multi_review);
    if (sum !== Number(row.total) || Number(row.total) <= 0) throw new Error(`${row.legal_name}: invalid category sum`);
  }
  console.log(JSON.stringify({ passed:true, readOnly:true, capturedAt:new Date().toISOString(), stableMaterialization:"wb-daily-inbox-pipeline/1.0.0", companies:rows }, null, 2));
} finally {
  await pool.end();
}
