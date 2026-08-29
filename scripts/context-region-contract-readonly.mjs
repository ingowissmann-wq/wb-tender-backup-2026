import fs from "node:fs";
import pg from "pg";
import {createFixedScopedPool,loadBackgroundScope} from "../platform/scoped-pg-pool.mjs";

const connectionString=fs.readFileSync(process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8").toString().trim();
const rawPool=new pg.Pool({connectionString,max:2,options:"-c default_transaction_read_only=on -c statement_timeout=60000 -c lock_timeout=3000"});
const scope=await loadBackgroundScope(rawPool),pool=createFixedScopedPool(rawPool,scope).pool,client=await pool.connect();
try{
  await client.query("BEGIN TRANSACTION READ ONLY");
  const contextRows=(await client.query(`WITH active_scope AS MATERIALIZED(
      SELECT scope.*,company.legal_name,
        CASE scope.canonical_service WHEN 'facility_management' THEN 'facility-management' WHEN 'emergency_services' THEN 'emergency-services' ELSE scope.canonical_service END service_line,
        active_version.id active_configuration_version_id
      FROM tender.configuration_scopes scope JOIN tender.enterprise_company_links company ON company.company_id=scope.company_id AND company.active AND company.tender_profile_id=scope.profile_id
      LEFT JOIN tender.configuration_active_parameters parameter ON parameter.company_id=scope.company_id AND parameter.parameter_key='A08'
        AND CASE parameter.service_line WHEN 'facility-management' THEN 'facility_management' WHEN 'emergency-services' THEN 'emergency_services' ELSE parameter.service_line END=scope.canonical_service
      LEFT JOIN tender.configuration_versions active_version ON active_version.id=parameter.version_id
        AND active_version.tenant_id=scope.tenant_id AND active_version.company_id=scope.company_id
        AND active_version.canonical_service=scope.canonical_service AND active_version.profile_id=scope.profile_id AND active_version.status='ACTIVE'
    ), active_lots AS MATERIALIZED(
      SELECT DISTINCT life.tender_id,life.lot_key
      FROM tender.tender_lot_lifecycles life JOIN tender.tenders t ON t.id=life.tender_id
      WHERE life.is_current AND life.lifecycle_status='ACTIVE' AND life.participation_status='ELIGIBLE'
        AND life.deadline_quality='EXACT' AND life.offer_deadline>now()
        AND t.data_class='PUBLIC_REAL' AND t.source_lifecycle_status='ACTIVE'
        AND t.participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE')
    ), active_tenders AS MATERIALIZED(
      SELECT DISTINCT tender_id FROM active_lots
    ), current_relevance AS MATERIALIZED(
      SELECT candidate.*,scope.tenant_id,scope.canonical_service,scope.profile_id,scope.active_region_version_id,scope.active_configuration_version_id,scope.legal_name
      FROM active_scope scope CROSS JOIN active_tenders active
      JOIN LATERAL(SELECT DISTINCT ON(relevance.lot_key) relevance.*
        FROM tender.service_relevance_evaluations relevance
        WHERE relevance.tender_id=active.tender_id AND relevance.company_id=scope.company_id AND relevance.service_line=scope.service_line
        ORDER BY relevance.lot_key,relevance.evaluation_version DESC,relevance.created_at DESC,relevance.id DESC)candidate ON true
      WHERE candidate.primary_company AND candidate.relevance_status='RELEVANT' AND candidate.service_scope_gate='PASSED'
        AND (candidate.lot_key IS NULL OR EXISTS(SELECT 1 FROM active_lots lot WHERE lot.tender_id=candidate.tender_id AND lot.lot_key=candidate.lot_key))
    ), contexts AS(
      SELECT relevance.tender_id,relevance.company_id,relevance.legal_name,relevance.lot_key,lot.id canonical_lot_id,
        relevance.tenant_id,relevance.canonical_service,relevance.profile_id,
        relevance.active_region_version_id,relevance.active_configuration_version_id,
        exact_region.id exact_region_id,legacy_region.id legacy_region_id
      FROM current_relevance relevance
      LEFT JOIN tender.lots lot ON lot.tender_id=relevance.tender_id AND lot.external_id=relevance.lot_key
      LEFT JOIN LATERAL(SELECT region.id FROM tender.region_evaluations region WHERE region.tender_id=relevance.tender_id AND region.company_id=relevance.company_id
        AND region.lot_id IS NOT DISTINCT FROM lot.id AND region.tenant_id=relevance.tenant_id AND region.canonical_service=relevance.canonical_service
        AND region.profile_id=relevance.profile_id AND region.region_profile_version_id=relevance.active_region_version_id
        AND region.configuration_version_id=relevance.active_configuration_version_id ORDER BY region.evaluation_version DESC LIMIT 1)exact_region ON true
      LEFT JOIN LATERAL(SELECT region.id FROM tender.region_evaluations region WHERE lot.id IS NOT NULL AND region.tender_id=relevance.tender_id AND region.company_id=relevance.company_id
        AND region.lot_id IS NULL AND region.tenant_id=relevance.tenant_id AND region.canonical_service=relevance.canonical_service
        AND region.profile_id=relevance.profile_id AND region.region_profile_version_id=relevance.active_region_version_id
        AND region.configuration_version_id=relevance.active_configuration_version_id ORDER BY region.evaluation_version DESC LIMIT 1)legacy_region ON true
    ) SELECT legal_name,company_id,
      count(*)::int active_contexts,
      count(*) FILTER(WHERE lot_key IS NOT NULL)::int lot_scoped_contexts,
      count(*) FILTER(WHERE lot_key IS NOT NULL AND canonical_lot_id IS NULL)::int missing_canonical_lot,
      count(*) FILTER(WHERE active_region_version_id IS NULL OR active_configuration_version_id IS NULL)::int missing_region_configuration,
      count(*) FILTER(WHERE exact_region_id IS NOT NULL)::int exact_current_region,
      count(*) FILTER(WHERE canonical_lot_id IS NOT NULL AND exact_region_id IS NULL)::int lot_regions_requiring_materialization,
      count(*) FILTER(WHERE canonical_lot_id IS NOT NULL AND legacy_region_id IS NOT NULL)::int legacy_tender_region_not_usable_for_lot
    FROM contexts GROUP BY legal_name,company_id ORDER BY legal_name`)).rows;
  const activeCompanies=(await client.query("SELECT company_id,legal_name FROM tender.enterprise_company_links WHERE active ORDER BY legal_name")).rows;
  const byCompany=new Map(contextRows.map(row=>[String(row.company_id),row]));
  const rows=activeCompanies.map(company=>byCompany.get(String(company.company_id))||{...company,active_contexts:0,lot_scoped_contexts:0,missing_canonical_lot:0,missing_region_configuration:0,exact_current_region:0,lot_regions_requiring_materialization:0,legacy_tender_region_not_usable_for_lot:0});
  const totals=rows.reduce((result,row)=>{for(const key of ["active_contexts","lot_scoped_contexts","missing_canonical_lot","missing_region_configuration","exact_current_region","lot_regions_requiring_materialization","legacy_tender_region_not_usable_for_lot"])result[key]=(result[key]||0)+Number(row[key]);return result},{});
  console.log(JSON.stringify({schema:"wb-tender/context-region-contract-readonly/1.0.0",capturedAt:new Date().toISOString(),status:"PRODUCTION_READ_ONLY_VERIFIED",transaction:"READ_ONLY_ROLLED_BACK",companyCount:rows.length,companies:rows,totals,externalWrite:false,transmitted:false},null,2));
  await client.query("ROLLBACK");
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{client.release();await rawPool.end()}
