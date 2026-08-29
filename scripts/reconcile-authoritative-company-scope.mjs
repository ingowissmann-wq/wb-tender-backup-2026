import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import {createFixedScopedPool,loadBackgroundScope} from "../platform/scoped-pg-pool.mjs";
import {classifyCompanyService,relevanceSnapshotHash} from "../platform/service-relevance.mjs";

const TARGET_COMPANY="b8bc1f97-60cb-4c5d-b42a-d31d44839c5a";
const CANDIDATE_SECURITY_COMPANY="7edf1812-b5e9-4b5c-addf-95d2339362b3";
const apply=process.argv.includes("--apply");
const expectedArg=process.argv.find(value=>value.startsWith("--expected-plan-sha256="));
const expectedPlanSha256=expectedArg?.split("=")[1]||"";
const stable=value=>Array.isArray(value)?`[${value.map(stable).join(",")}]`:value&&typeof value==="object"?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`:JSON.stringify(value);
const hash=value=>crypto.createHash("sha256").update(stable(value)).digest("hex");
const connectionString=process.env.DATABASE_URL||fs.readFileSync(process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8").trim();
const rawPool=new pg.Pool({connectionString,max:1,options:[!apply?"-c default_transaction_read_only=on":"","-c statement_timeout=120000",process.env.DATABASE_SESSION_OPTIONS].filter(Boolean).join(" ")});
const fixed=createFixedScopedPool(rawPool,await loadBackgroundScope(rawPool));
const pool=fixed.pool;
const q=async(text,params=[])=>(await pool.query(text,params)).rows;

const company=(await q(`SELECT company.*,scope.tenant_id,scope.canonical_service,scope.profile_id,
    scope.active_region_version_id,profile.version profile_version,profile.capabilities,
    determination.id determination_id,determination.version_no determination_version,
    determination.authority_sha256
  FROM tender.enterprise_company_links company
  JOIN tender.configuration_scopes scope ON scope.company_id=company.company_id AND scope.profile_id=company.tender_profile_id
  JOIN tender.company_profiles profile ON profile.id=scope.profile_id
  JOIN tender.current_authoritative_company_scopes determination ON determination.company_id=company.company_id
  WHERE company.company_id=$1`,[TARGET_COMPANY]))[0];
if(!company||company.legal_name!=="WB-Protect & Service GmbH"||company.canonical_service!=="security")throw new Error("authoritative_target_scope_mismatch");

const safety=(await q("SELECT external_submission_enabled,allow_external_submission,global_kill_switch FROM tender.submission_runtime_settings"))[0];
if(safety?.external_submission_enabled||safety?.allow_external_submission||safety?.global_kill_switch!==true)throw new Error("submission_safety_not_locked");

const candidateRows=await q(`SELECT relevance.tender_id,relevance.lot_key,relevance.enrichment_version_id,
    tender.external_id,tender.notice_number,tender.title,tender.description,
    tender.cpv_codes,tender.regions,tender.offer_deadline,tender.source_lifecycle_status,
    enrichment.version enrichment_version,enrichment.structured_data enrichment_structured_data,
    enrichment.payload_sha256 enrichment_sha256,lot.id enrichment_lot_id,lot.structured_data lot_structured_data
  FROM tender.current_service_relevance relevance
  JOIN tender.tenders tender ON tender.id=relevance.tender_id
  JOIN tender.enrichment_versions enrichment ON enrichment.id=relevance.enrichment_version_id
  LEFT JOIN tender.enrichment_lots lot ON lot.enrichment_version_id=enrichment.id AND lot.lot_key=relevance.lot_key
  WHERE relevance.company_id=$1 AND relevance.service_line='security'
    AND relevance.relevance_status='RELEVANT' AND relevance.service_scope_gate='PASSED' AND relevance.primary_company=true
    AND tender.data_class='PUBLIC_REAL' AND tender.source_lifecycle_status='ACTIVE'
    AND tender.participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE')
    AND (tender.offer_deadline IS NULL OR tender.offer_deadline>now())
  ORDER BY relevance.tender_id,relevance.lot_key NULLS FIRST`,[CANDIDATE_SECURITY_COMPANY]);

const parameters=[{parameter_key:"A15",new_value:{companyId:TARGET_COMPANY,serviceArea:"security",scopeAllowed:true,primaryAssignment:false,status:"VERIFIED",source:"AUTHORITATIVE_COMPANY_SCOPE"},status:"PROVIDED"}];
const assessments=[];
for(const row of candidateRows){
  const lot=row.lot_key?{...(row.lot_structured_data||{}),id:row.enrichment_lot_id,lot_key:row.lot_key,external_id:row.lot_key}:null;
  const result=classifyCompanyService({tender:row,lot,enrichment:{structured_data:row.enrichment_structured_data},company,parameters,profile:{capabilities:company.capabilities}});
  if(result.relevanceStatus!=="RELEVANT")continue;
  assessments.push({
    tenderId:row.tender_id,lotKey:row.lot_key,enrichmentVersionId:row.enrichment_version_id,
    enrichmentVersion:Number(row.enrichment_version),enrichmentSha256:row.enrichment_sha256,
    result:{...result,relevanceStatus:"POTENTIALLY_RELEVANT",serviceScopeGate:"REVIEW_REQUIRED",primaryCompany:false,processable:false,
      reason:`Autoritativer security-Fachscope bestätigt; tenderbezogene Primärgesellschaft und Region für WB-Protect & Service GmbH sind noch fachlich festzulegen. ${result.reason}`},
  });
}
const plan={schemaVersion:1,companyId:TARGET_COMPANY,tenantId:company.tenant_id,canonicalService:"security",
  profileId:company.profile_id,profileVersion:Number(company.profile_version),determinationId:company.determination_id,
  determinationVersion:Number(company.determination_version),authoritySha256:company.authority_sha256,
  candidateSourceCompanyId:CANDIDATE_SECURITY_COMPANY,candidateContextCount:candidateRows.length,
  independentlyMatchedContextCount:assessments.length,activeRegionVersionId:company.active_region_version_id,
  targetStatus:"POTENTIALLY_RELEVANT",targetGate:"REVIEW_REQUIRED",externalWrite:false,transmitted:false,
  contexts:assessments.map(item=>({tenderId:item.tenderId,lotKey:item.lotKey,enrichmentVersionId:item.enrichmentVersionId,
    enrichmentSha256:item.enrichmentSha256,positiveSignals:item.result.positiveSignals,positiveCpv:item.result.positiveCpv}))};
const planSha256=hash(plan);

if(!apply){
  console.log(JSON.stringify({mode:"READ_ONLY_PLAN",planSha256,plan,safety,requiredApplyArgument:`--expected-plan-sha256=${planSha256}`},null,2));
  await rawPool.end();
  process.exit(0);
}
if(expectedPlanSha256!==planSha256)throw new Error("scope_reconciliation_plan_hash_mismatch");

const client=await pool.connect();
let inserted=0,skipped=0;
try{
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`authoritative-scope-reconciliation:${TARGET_COMPANY}`]);
  const locked=(await client.query(`SELECT company.tender_profile_id,scope.tenant_id,scope.canonical_service,
      determination.id determination_id,determination.authority_sha256
    FROM tender.enterprise_company_links company
    JOIN tender.configuration_scopes scope ON scope.company_id=company.company_id AND scope.profile_id=company.tender_profile_id
    JOIN tender.current_authoritative_company_scopes determination ON determination.company_id=company.company_id
    WHERE company.company_id=$1 FOR SHARE OF company,scope`,[TARGET_COMPANY])).rows[0];
  if(!locked||String(locked.tender_profile_id)!==String(company.profile_id)||String(locked.determination_id)!==String(company.determination_id)||locked.authority_sha256!==company.authority_sha256)throw new Error("authoritative_scope_changed_during_reconciliation");
  for(const item of assessments){
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`service-relevance:${item.tenderId}:${TARGET_COMPANY}:${item.lotKey||""}`]);
    const snapshot=relevanceSnapshotHash({pipeline:"authoritative-scope-reconciliation-131.17",tenderId:item.tenderId,
      lotKey:item.lotKey,companyId:TARGET_COMPANY,enrichmentVersion:item.enrichmentVersion,
      companyProfileId:company.profile_id,authoritySha256:company.authority_sha256,planSha256});
    const version=Number((await client.query("SELECT coalesce(max(evaluation_version),0)+1 version FROM tender.service_relevance_evaluations WHERE tender_id=$1 AND company_id=$2 AND lot_key IS NOT DISTINCT FROM $3",[item.tenderId,TARGET_COMPANY,item.lotKey])).rows[0].version);
    const write=await client.query(`INSERT INTO tender.service_relevance_evaluations(
      tender_id,enrichment_version_id,company_id,lot_key,evaluation_version,classifier_version,snapshot_sha256,
      relevance_status,service_scope_gate,primary_company,alternative_company,service_line,recommendation,reason,
      positive_signals,exclusion_signals,applied_cpv_codes,applied_rules,source_manifest)
      SELECT $1,$2,$3,$4,$5,'authoritative-scope-reconciliation-131.17',$6,
        'POTENTIALLY_RELEVANT','REVIEW_REQUIRED',false,false,'security','MANUAL_COMPANY_ASSIGNMENT_REQUIRED',$7,
        $8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb
      WHERE NOT EXISTS(SELECT 1 FROM tender.service_relevance_evaluations existing
        WHERE existing.tender_id=$1 AND existing.company_id=$3 AND existing.lot_key IS NOT DISTINCT FROM $4
          AND existing.snapshot_sha256=$6)`,[item.tenderId,item.enrichmentVersionId,TARGET_COMPANY,item.lotKey,version,snapshot,
      item.result.reason,JSON.stringify(item.result.positiveSignals),JSON.stringify(item.result.exclusionSignals),
      JSON.stringify(item.result.cpvCodes),JSON.stringify(item.result.appliedRules),JSON.stringify({
        planSha256,authoritySha256:company.authority_sha256,authorityVersion:Number(company.determination_version),
        candidateDiscovery:"CURRENT_WB_SECURITY_RELEVANCE",independentTaxonomyMatch:true,noCrossCompanyDataCopied:true,
        regionCheck:company.active_region_version_id?"CONFIGURED":"REGION_CONFIGURATION_REQUIRED",
        calculationProfileCheck:"SECURITY_PROFILE_APPROVAL_REQUIRED",externalWrite:false,transmitted:false})]);
    if(write.rowCount===1)inserted++;else skipped++;
  }
  const finalSafety=(await client.query("SELECT external_submission_enabled,allow_external_submission,global_kill_switch FROM tender.submission_runtime_settings FOR SHARE")).rows[0];
  if(finalSafety.external_submission_enabled||finalSafety.allow_external_submission||finalSafety.global_kill_switch!==true)throw new Error("submission_safety_changed_during_reconciliation");
  await client.query("INSERT INTO tender.audit_events(action,metadata) VALUES('AUTHORITATIVE_COMPANY_SCOPE_RECONCILED',$1::jsonb)",[JSON.stringify({companyId:TARGET_COMPANY,planSha256,inserted,skipped,candidateContextCount:candidateRows.length,independentlyMatchedContextCount:assessments.length,regionStatus:company.active_region_version_id?"CONFIGURED":"REGION_CONFIGURATION_REQUIRED",calculationStatus:"SECURITY_PROFILE_APPROVAL_REQUIRED",externalWrite:false,transmitted:false})]);
  await client.query("COMMIT");
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{await client.release();await rawPool.end()}
console.log(JSON.stringify({mode:"APPLIED",planSha256,inserted,skipped,externalWrite:false,transmitted:false},null,2));
