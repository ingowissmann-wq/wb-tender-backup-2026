import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import {createFixedScopedPool,loadBackgroundScope} from "../platform/scoped-pg-pool.mjs";

const connectionString=fs.readFileSync(process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8").toString().trim();
const rawPool=new pg.Pool({connectionString,max:2,options:"-c default_transaction_read_only=on -c statement_timeout=60000 -c lock_timeout=3000"});
const scope=await loadBackgroundScope(rawPool),pool=createFixedScopedPool(rawPool,scope).pool,client=await pool.connect();
const digest=rows=>crypto.createHash("sha256").update(JSON.stringify(rows.map(row=>Object.fromEntries(Object.entries(row).sort())).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest("hex");
try{
  await client.query("BEGIN TRANSACTION READ ONLY");
  const rows=(await client.query(`WITH active_scope AS MATERIALIZED(
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
      SELECT DISTINCT life.tender_id,life.lot_key,life.offer_deadline
      FROM tender.tender_lot_lifecycles life JOIN tender.tenders tender ON tender.id=life.tender_id
      WHERE life.is_current AND life.lifecycle_status='ACTIVE' AND life.participation_status='ELIGIBLE'
        AND life.deadline_quality='EXACT' AND life.offer_deadline>now()
        AND tender.data_class='PUBLIC_REAL' AND tender.source_lifecycle_status='ACTIVE'
        AND tender.participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE')
    ), active_tenders AS MATERIALIZED(SELECT DISTINCT tender_id FROM active_lots), current_relevance AS MATERIALIZED(
      SELECT candidate.*,scope.tenant_id,scope.canonical_service,scope.profile_id,scope.active_region_version_id,scope.active_configuration_version_id,scope.legal_name
      FROM active_scope scope CROSS JOIN active_tenders active
      JOIN LATERAL(SELECT DISTINCT ON(relevance.lot_key) relevance.* FROM tender.service_relevance_evaluations relevance
        WHERE relevance.tender_id=active.tender_id AND relevance.company_id=scope.company_id AND relevance.service_line=scope.service_line
        ORDER BY relevance.lot_key,relevance.evaluation_version DESC,relevance.created_at DESC,relevance.id DESC)candidate ON true
      WHERE candidate.primary_company AND candidate.relevance_status='RELEVANT' AND candidate.service_scope_gate='PASSED'
        AND (candidate.lot_key IS NULL OR EXISTS(SELECT 1 FROM active_lots lot WHERE lot.tender_id=candidate.tender_id AND lot.lot_key=candidate.lot_key))
    ), contexts AS(
      SELECT relevance.tenant_id,relevance.company_id,relevance.legal_name,relevance.tender_id,relevance.lot_key,lot.id canonical_lot_id,
        relevance.canonical_service,relevance.profile_id,relevance.active_region_version_id,relevance.active_configuration_version_id,
        exact_region.id exact_region_id,min(active_lot.offer_deadline) offer_deadline
      FROM current_relevance relevance
      LEFT JOIN tender.lots lot ON lot.tender_id=relevance.tender_id AND lot.external_id=relevance.lot_key
      LEFT JOIN active_lots active_lot ON active_lot.tender_id=relevance.tender_id AND (relevance.lot_key IS NULL OR active_lot.lot_key=relevance.lot_key)
      LEFT JOIN LATERAL(SELECT region.id FROM tender.region_evaluations region WHERE region.tender_id=relevance.tender_id AND region.company_id=relevance.company_id
        AND region.lot_id IS NOT DISTINCT FROM lot.id AND region.tenant_id=relevance.tenant_id AND region.canonical_service=relevance.canonical_service
        AND region.profile_id=relevance.profile_id AND region.region_profile_version_id=relevance.active_region_version_id
        AND region.configuration_version_id=relevance.active_configuration_version_id ORDER BY region.evaluation_version DESC LIMIT 1)exact_region ON true
      GROUP BY relevance.tenant_id,relevance.company_id,relevance.legal_name,relevance.tender_id,relevance.lot_key,lot.id,
        relevance.canonical_service,relevance.profile_id,relevance.active_region_version_id,relevance.active_configuration_version_id,exact_region.id
    ) SELECT * FROM contexts ORDER BY legal_name,tender_id,lot_key NULLS FIRST`)).rows;
  const fields=row=>({tenant_id:row.tenant_id,company_id:row.company_id,tender_id:row.tender_id,lot_key:row.lot_key,canonical_lot_id:row.canonical_lot_id,canonical_service:row.canonical_service,profile_id:row.profile_id,active_region_version_id:row.active_region_version_id,active_configuration_version_id:row.active_configuration_version_id,offer_deadline:row.offer_deadline});
  const ready=rows.filter(row=>row.canonical_lot_id&&row.active_region_version_id&&row.active_configuration_version_id&&!row.exact_region_id).map(fields);
  const evidenceRequired=rows.filter(row=>!row.active_region_version_id||!row.active_configuration_version_id).map(fields);
  const summarize=set=>Object.values(set.reduce((map,row)=>{const key=row.company_id,entry=map[key]||{companyId:key,company:rows.find(item=>item.company_id===key)?.legal_name,count:0};entry.count++;map[key]=entry;return map},{}));
  console.log(JSON.stringify({schema:"wb-tender/region-context-rematerialization-plan-readonly/1.0.0",capturedAt:new Date().toISOString(),status:"PRODUCTION_READ_ONLY_VERIFIED",transaction:"READ_ONLY_ROLLED_BACK",ready:{count:ready.length,sha256:digest(ready),byCompany:summarize(ready),allCanonicalLotsPresent:ready.every(row=>Boolean(row.canonical_lot_id)),allDeadlinesOpen:ready.every(row=>new Date(row.offer_deadline)>new Date())},authoritativeEvidenceRequired:{count:evidenceRequired.length,sha256:digest(evidenceRequired),byCompany:summarize(evidenceRequired)},externalWrite:false,transmitted:false},null,2));
  await client.query("ROLLBACK");
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{client.release();await rawPool.end()}
