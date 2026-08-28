import fs from "node:fs";
import pg from "pg";
import {createFixedScopedPool,loadBackgroundScope} from "../platform/scoped-pg-pool.mjs";
import {FAMILY_ADAPTER_CAPABILITIES,COMPANY_CONFIGURATION_CAPABILITIES,INTERNAL_PLATFORM_CAPABILITIES,
  observedPortalFamily,portalOperationalRelevance,familyAdapterMaturity} from "../platform/portal-readiness-dimensions.mjs";
import {FAMILY_INTERNAL_REPLAY_EVIDENCE} from "../platform/portal-readiness-dimensions.mjs";
import {classifyPortalFeatureGap,hasConcreteAdapterImplementation} from "../platform/company-portal-capability-status.mjs";

const connectionString=process.env.DATABASE_URL||fs.readFileSync(process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8").trim();
const rawPool=new pg.Pool({connectionString,max:1,options:["-c default_transaction_read_only=on -c statement_timeout=120000",process.env.DATABASE_SESSION_OPTIONS].filter(Boolean).join(" ")});
const pool=createFixedScopedPool(rawPool,await loadBackgroundScope(rawPool)).pool;
const client=await pool.connect();
const query=async(sql,params=[])=>(await client.query(sql,params)).rows;
const detail=process.argv.includes("--detail");
const featureMap=Object.freeze({LOGIN_START:"LOGIN",LOGIN_VERIFY:"LOGIN",MFA_CAPTCHA_CONTINUE:"MFA",SESSION_STORE:"LOGIN",
  PUBLIC_DOCUMENT_DOWNLOAD:"DOCUMENT_DOWNLOAD",PROTECTED_DOCUMENT_DOWNLOAD:"DOCUMENT_DOWNLOAD",AMENDMENTS_DETECT:"AMENDMENTS",
  TENDER_OPEN:"DISCOVERY",LOT_OPEN:"NOTICES",SUBMISSION_PREFLIGHT:"SUBMISSION_PREFLIGHT",PACKAGE_UPLOAD:"SUBMISSION",
  BINDING_SUBMIT:"SUBMISSION",RECEIPT_DOWNLOAD:"SUBMISSION",SUBMISSION_STATUS:"MONITORING"});
const legacyFeatureMap=Object.freeze({LOGIN_START:"LOGIN",LOGIN_VERIFY:"LOGIN",MFA_CONTINUE:"MFA",SESSION_STORE:"LOGIN",
  PUBLIC_DOCUMENT_DOWNLOAD:"DOCUMENT_DOWNLOAD",PROTECTED_DOCUMENT_DOWNLOAD:"DOCUMENT_DOWNLOAD",AMENDMENTS_DETECT:"AMENDMENTS",
  BIDDER_IDENTITY_CONFIRM:"LOGIN",COMPANY_SELECT:"PARTICIPATION",TENDER_OPEN:"DISCOVERY",LOT_OPEN:"NOTICES",
  SUBMISSION_PREFLIGHT:"SUBMISSION_PREFLIGHT",PACKAGE_UPLOAD:"SUBMISSION",BINDING_SUBMIT:"SUBMISSION",
  RECEIPT_DOWNLOAD:"SUBMISSION",SUBMISSION_STATUS:"MONITORING"});
const publicationCapabilities=new Set(["PUBLIC_DOCUMENT_DOWNLOAD","AMENDMENTS_DETECT","TENDER_OPEN","LOT_OPEN"]);
const submissionCapabilities=new Set(["SUBMISSION_PREFLIGHT","PACKAGE_UPLOAD","BINDING_SUBMIT","RECEIPT_DOWNLOAD","SUBMISSION_STATUS"]);
const legacyNeedsCredential=new Set(["LOGIN_START","LOGIN_VERIFY","MFA_CONTINUE","SESSION_STORE","PROTECTED_DOCUMENT_DOWNLOAD",
  "BIDDER_IDENTITY_CONFIRM","COMPANY_SELECT","SUBMISSION_PREFLIGHT","PACKAGE_UPLOAD","BINDING_SUBMIT","RECEIPT_DOWNLOAD","SUBMISSION_STATUS"]);
const legacyPublicRead=new Set(["PUBLIC_DOCUMENT_DOWNLOAD","TENDER_OPEN"]);

try{
  await client.query("BEGIN READ ONLY");
  const companies=await query(`SELECT company.company_id,company.legal_name,binding.tenant_id,binding.tenant_count,
      coalesce(scope.scope_count,0)::int scope_count,scope.scope_tenant_id
    FROM tender.enterprise_company_links company
    LEFT JOIN LATERAL(SELECT min(tenant_id::text)::uuid tenant_id,count(DISTINCT tenant_id)::int tenant_count FROM saas.legacy_company_tenant_bindings WHERE company_id=company.company_id) binding ON true
    LEFT JOIN LATERAL(SELECT count(*)::int scope_count,min(tenant_id::text)::uuid scope_tenant_id FROM tender.configuration_scopes WHERE company_id=company.company_id AND profile_id=company.tender_profile_id) scope ON true
    WHERE company.active ORDER BY company.legal_name`);
  const dbAdapters=await query(`SELECT portal_code,mode,supported_actions,last_success_at,last_error_code FROM tender.portal_adapters ORDER BY portal_code`);
  const connectors=await query(`SELECT adapter_id,adapter_version,contract_version,canonical_domain,enabled,validation_status,last_verified_at FROM tender.portal_connector_adapters ORDER BY adapter_id,canonical_domain`);
  const portals=await query(`WITH active_tender AS (
      SELECT id FROM tender.tenders WHERE data_class='PUBLIC_REAL' AND source_lifecycle_status='ACTIVE'
        AND wb_relevance_status IN('RELEVANT','REVIEW_REQUIRED') AND participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE')
        AND (offer_deadline IS NULL OR offer_deadline>now()))
    SELECT portal.id,portal.display_name,portal.canonical_domain,portal.portal_family_key,portal.adapter_id,portal.adapter_version,
      portal.adapter_enabled,portal.adapter_validation_status,coalesce(profile.portal_type,'UNCLASSIFIED') portal_role,
      sample.sample_url,sample.sample_role,
      (SELECT count(DISTINCT assignment.tender_id) FROM tender.tender_portal_assignments assignment JOIN active_tender tender ON tender.id=assignment.tender_id WHERE assignment.portal_id=portal.id AND assignment.status='ACTIVE' AND assignment.superseded_at IS NULL)::int active_assignments,
      (SELECT count(DISTINCT resolution.tender_id) FROM tender.tender_portal_resolutions resolution JOIN active_tender tender ON tender.id=resolution.tender_id WHERE resolution.portal_id=portal.id AND resolution.resolution_status='UNIQUE_EVIDENCE')::int active_resolutions,
      (SELECT count(DISTINCT link.tender_id) FROM tender.tender_external_links link JOIN active_tender tender ON tender.id=link.tender_id WHERE link.verification_status='VERIFIED' AND (lower(coalesce(link.final_host,link.original_host))=portal.canonical_domain OR lower(coalesce(link.final_host,link.original_host))=ANY(portal.allowed_subdomains)))::int active_official_links,
      (SELECT count(*) FROM tender.portal_credential_secrets secret JOIN tender.portal_credential_companies company ON company.credential_id=secret.id AND company.active WHERE secret.portal_id=portal.id AND secret.status='ACTIVE' AND (secret.valid_until IS NULL OR secret.valid_until>now()))::int active_credentials,
      (SELECT count(*) FROM tender.portal_connection_events event WHERE event.portal_id=portal.id AND event.occurred_at>=now()-interval '12 months')::int recent_events,
      EXISTS(SELECT 1 FROM tender.portal_connector_adapters connector WHERE connector.enabled AND connector.adapter_id=portal.adapter_id) active_connector,
      EXISTS(SELECT 1 FROM tender.scheduler_sources source WHERE source.enabled AND NOT source.kill_switch AND lower(source.source_code)=lower(portal.discovery_source)) active_source
    FROM tender.portal_registry portal
    LEFT JOIN tender.portal_capability_profiles profile ON profile.portal_id=portal.id
    LEFT JOIN LATERAL(SELECT coalesce(link.final_url,link.original_url) sample_url,link.role sample_role FROM tender.tender_external_links link WHERE lower(coalesce(link.final_host,link.original_host))=portal.canonical_domain OR lower(coalesce(link.final_host,link.original_host))=ANY(portal.allowed_subdomains)
      ORDER BY CASE WHEN coalesce(link.final_url,link.original_url)~*'/(VMP)?Satellite/notice/|/Vergabe/notice/|/NetServer(/|$)' THEN 0 ELSE 1 END,
        link.verified_at DESC NULLS LAST,link.created_at DESC LIMIT 1) sample ON true
    ORDER BY portal.canonical_domain`);
  const features=await query(`SELECT portal_id,feature_key,portal_support,autopilot_supported,actively_configured,production_tested,browser_acceptance_passed FROM tender.current_portal_host_capability_truth`);
  const featureByPortal=new Map(features.map(row=>[`${row.portal_id}:${row.feature_key}`,row]));
  const featureFor=(portal,key)=>featureByPortal.get(`${portal.id}:${key}`);
  const implemented=feature=>Boolean(feature&&feature.portal_support==='SUPPORTED'&&feature.autopilot_supported&&feature.actively_configured);
  const ready=feature=>Boolean(implemented(feature)&&feature.production_tested&&feature.browser_acceptance_passed);
  const operatorEvidence={
    "vergabe.bremen.de":"Administration Intelligence AG","vergabe.deges.de":"Administration Intelligence AG",
    "vergabe.hessen.de":"Administration Intelligence AG","vergabe.muenchen.de":"Administration Intelligence AG",
    "vergabekooperation.berlin":"Administration Intelligence AG","www.sachsen-vergabe.de":"Administration Intelligence AG",
  };
  const portalRows=portals.map(portal=>{
    const family=observedPortalFamily({adapterId:portal.adapter_id,domain:portal.canonical_domain,sampleUrl:portal.sample_url,operatorEvidence:operatorEvidence[portal.canonical_domain]});
    const usage=portalOperationalRelevance({activeAssignments:portal.active_assignments,activeResolutions:portal.active_resolutions,
      activeOfficialLinks:portal.active_official_links,activeCredentials:portal.active_credentials,recentEvents:portal.recent_events,
      activeConnector:portal.active_connector,activeSource:portal.active_source});
    return {...portal,observedFamilyKey:family.familyKey,familyEvidence:family.evidence,familyConfidence:family.confidence,operationallyRelevant:usage.relevant,relevanceReasons:usage.reasons};
  });
  const families=[];
  for(const familyKey of [...new Set(portalRows.map(row=>row.observedFamilyKey))].sort()){
    const members=portalRows.filter(row=>row.observedFamilyKey===familyKey),relevantMembers=members.filter(row=>row.operationallyRelevant);
    const familyFeatures={};
    for(const capability of FAMILY_ADAPTER_CAPABILITIES){
      const featureKey=featureMap[capability];
      const evidenceMembers=(relevantMembers.length?relevantMembers:members).map(portal=>featureFor(portal,featureKey));
      familyFeatures[capability]={implemented:evidenceMembers.some(implemented),internallyValidated:evidenceMembers.some(ready),externalValidationPending:!evidenceMembers.some(ready)};
    }
    const internalEvidence=FAMILY_INTERNAL_REPLAY_EVIDENCE[familyKey];
    const maturity=familyAdapterMaturity({familyKey,dbAdapterCodes:dbAdapters.map(row=>row.portal_code),
      readCapabilitiesComplete:internalEvidence?.readCapabilitiesComplete===true,
      submissionProtocolImplemented:internalEvidence?.submissionProtocolImplemented===true,
      mockReplayContractPassed:internalEvidence?.mockReplayContractPassed===true});
    families.push({familyKey,portalCount:members.length,relevantPortalCount:relevantMembers.length,
      domains:members.map(row=>row.canonical_domain),adapterIds:[...new Set(members.map(row=>row.adapter_id))],
      roles:[...new Set(members.map(row=>row.portal_role))],maturity,internalEvidence:internalEvidence||null,capabilities:familyFeatures});
  }
  const legacyCapabilities=["LOGIN_START","LOGIN_VERIFY","MFA_CONTINUE","SESSION_STORE","PUBLIC_DOCUMENT_DOWNLOAD",
    "PROTECTED_DOCUMENT_DOWNLOAD","AMENDMENTS_DETECT","BIDDER_IDENTITY_CONFIRM","COMPANY_SELECT","TENDER_OPEN","LOT_OPEN",
    "SUBMISSION_PREFLIGHT","PACKAGE_UPLOAD","BINDING_SUBMIT","RECEIPT_DOWNLOAD","SUBMISSION_STATUS"];
  const uniqueLegacyUnsupported=[];
  for(const portal of portals){
    const required=portal.portal_role==='BEKANNTMACHUNGSPLATTFORM'?legacyCapabilities.filter(item=>publicationCapabilities.has(item)):legacyCapabilities;
    for(const capability of required){
      const featureKey=legacyFeatureMap[capability],feature=featureFor(portal,featureKey);
      const featureSufficient=legacyNeedsCredential.has(capability)&&['LOGIN','MFA'].includes(featureKey)?implemented(feature):ready(feature);
      let unsupported=false;
      if(!featureSufficient)unsupported=classifyPortalFeatureGap(portal,feature)==='UNSUPPORTED_PORTAL_REQUIRES_ADAPTER';
      else if(legacyPublicRead.has(capability))unsupported=false;
      else if(legacyNeedsCredential.has(capability)&&!implemented(featureFor(portal,'LOGIN')))
        unsupported=classifyPortalFeatureGap(portal,featureFor(portal,'LOGIN'))==='UNSUPPORTED_PORTAL_REQUIRES_ADAPTER';
      else if(!portal.adapter_enabled)unsupported=!hasConcreteAdapterImplementation(portal);
      if(unsupported)uniqueLegacyUnsupported.push({portalId:portal.id,capability});
    }
  }
  const historicalCompanyFactor=5,currentCompanyFactor=companies.length,uniqueLegacyCount=uniqueLegacyUnsupported.length;
  const historicalRaw=uniqueLegacyCount*historicalCompanyFactor,currentRaw=uniqueLegacyCount*currentCompanyFactor;
  const submissionUnique=uniqueLegacyUnsupported.filter(item=>submissionCapabilities.has(item.capability)).length;
  const publicUnique=uniqueLegacyUnsupported.filter(item=>publicationCapabilities.has(item.capability)).length;
  const legacyUniqueByCapability=Object.fromEntries(legacyCapabilities.map(capability=>[
    capability,uniqueLegacyUnsupported.filter(item=>item.capability===capability).length]));
  const relevantFamilies=families.filter(row=>row.relevantPortalCount>0);
  const portalById=new Map(portalRows.map(row=>[String(row.id),row]));
  const familyByKey=new Map(families.map(row=>[row.familyKey,row]));
  const consolidatedLegacyGaps=uniqueLegacyUnsupported.map(gap=>{
    const portal=portalById.get(String(gap.portalId)),family=familyByKey.get(portal?.observedFamilyKey);
    const category=!portal?.operationallyRelevant?'INACTIVE_HISTORICAL_OR_THEORETICAL':
      family?.maturity?.internallyTested?'EXTERNAL_VALIDATION_PENDING':
        family?.maturity?.implemented?'INTERNAL_CONTRACT_TEST_REPAIR_REQUIRED':'ADAPTER_IMPLEMENTATION_REQUIRED';
    return {...gap,category,familyKey:portal?.observedFamilyKey||null};
  });
  const consolidatedUniqueByCategory=Object.fromEntries([
    'EXTERNAL_VALIDATION_PENDING','INTERNAL_CONTRACT_TEST_REPAIR_REQUIRED','ADAPTER_IMPLEMENTATION_REQUIRED',
    'INACTIVE_HISTORICAL_OR_THEORETICAL'].map(category=>[category,
      consolidatedLegacyGaps.filter(gap=>gap.category===category).length]));
  const companyConfiguration=companies.map(company=>({companyId:company.company_id,company:company.legal_name,tenantId:company.tenant_id,
    internalPlatformContextStatus:Number(company.tenant_count)===1&&Number(company.scope_count)===1&&String(company.tenant_id)===String(company.scope_tenant_id)?'READY':'DATA_CONTEXT_REPAIR_REQUIRED',
    capabilityCount:COMPANY_CONFIGURATION_CAPABILITIES.length}));
  const summary={distinctPortals:portalRows.length,rawRegistryFamilyKeys:new Set(portals.map(row=>row.portal_family_key)).size,
    deduplicatedObservedFamilies:families.length,operationallyRelevantPortals:portalRows.filter(row=>row.operationallyRelevant).length,
    operationallyRelevantFamilies:relevantFamilies.length,databaseReadAdapterDefinitions:new Set(dbAdapters.map(row=>row.portal_code)).size,
    connectorDefinitions:new Set(connectors.map(row=>row.adapter_id)).size,
    implementedFamilyAdapters:relevantFamilies.filter(row=>row.maturity.implemented).length,
    trulyMissingFamilyAdapters:relevantFamilies.filter(row=>!row.maturity.implemented).length,
    internallyFullyTestedFamilyAdapters:relevantFamilies.filter(row=>row.maturity.internallyTested).length,
    externalValidationOnlyPending:relevantFamilies.filter(row=>row.maturity.status==='INTERNALLY_READY').length,
    inactiveHistoricalOrTheoreticalPortals:portalRows.filter(row=>!row.operationallyRelevant).length,
    legacyThirdAudit:{reportedUnsupportedEvaluations:4650,reconstructedUniquePortalCapabilityGaps:uniqueLegacyCount,
      interpretation:'LEGACY_CARTESIAN_EVALUATIONS_NOT_DISTINCT_ADAPTER_IMPLEMENTATIONS',
      reconstructedCompanyFactor:historicalCompanyFactor,reconstructedRawEvaluations:historicalRaw,
      artificialDuplicateEvaluations:historicalRaw-uniqueLegacyCount,submissionOnlyEvaluations:submissionUnique*historicalCompanyFactor,
      publicNoticeOrDocumentEvaluations:publicUnique*historicalCompanyFactor,uniqueByCapability:legacyUniqueByCapability},
    consolidatedCurrentGaps:{uniqueByCategory:consolidatedUniqueByCategory,
      expandedBySixCompanies:Object.fromEntries(Object.entries(consolidatedUniqueByCategory).map(([category,count])=>[category,count*currentCompanyFactor])),
      internallyRepairableUnique:consolidatedUniqueByCategory.INTERNAL_CONTRACT_TEST_REPAIR_REQUIRED+
        consolidatedUniqueByCategory.ADAPTER_IMPLEMENTATION_REQUIRED,
      externalValidationPendingUnique:consolidatedUniqueByCategory.EXTERNAL_VALIDATION_PENDING,
      inactiveHistoricalOrTheoreticalUnique:consolidatedUniqueByCategory.INACTIVE_HISTORICAL_OR_THEORETICAL},
    currentLegacyMatrix:{status:'DEPRECATED_CARTESIAN_VIEW',companyFactor:currentCompanyFactor,
      rawLegacyEvaluations:currentRaw,artificialDuplicateEvaluations:currentRaw-uniqueLegacyCount,
      internallyUnsupportedEvaluations:(consolidatedUniqueByCategory.INTERNAL_CONTRACT_TEST_REPAIR_REQUIRED+
        consolidatedUniqueByCategory.ADAPTER_IMPLEMENTATION_REQUIRED)*currentCompanyFactor},
    readinessDimensions:{internalPlatformCapabilityCount:INTERNAL_PLATFORM_CAPABILITIES.length,
      familyAdapterCapabilityCount:FAMILY_ADAPTER_CAPABILITIES.length,companyConfigurationCapabilityCount:COMPANY_CONFIGURATION_CAPABILITIES.length}};
  await client.query("ROLLBACK");
  console.log(JSON.stringify({capturedAt:new Date().toISOString(),transaction:"READ_ONLY_ROLLED_BACK",summary,
    companyConfiguration,families:detail?families:families.map(({capabilities,...row})=>row),portals:detail?portalRows:undefined},null,2));
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{await client.release();await rawPool.end()}
