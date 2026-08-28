import fs from "node:fs";
import pg from "pg";
import { createFixedScopedPool, loadBackgroundScope } from "../platform/scoped-pg-pool.mjs";
import { classifyPortalFeatureGap, companyContextStatus, hasConcreteAdapterImplementation } from "../platform/company-portal-capability-status.mjs";
import {FAMILY_INTERNAL_REPLAY_EVIDENCE,observedPortalFamily,portalOperationalRelevance} from "../platform/portal-readiness-dimensions.mjs";

const connectionString = process.env.DATABASE_URL || fs.readFileSync(
  process.env.DATABASE_URL_FILE || "/run/secrets/database_url", "utf8",
).trim();
const rawPool = new pg.Pool({connectionString,max:1,options:["-c default_transaction_read_only=on -c statement_timeout=120000",process.env.DATABASE_SESSION_OPTIONS].filter(Boolean).join(" ")});
const pool = createFixedScopedPool(rawPool, await loadBackgroundScope(rawPool)).pool;
const client = await pool.connect();
const query = async (sql,params=[]) => (await client.query(sql,params)).rows;
const includeDetail = process.argv.includes("--detail");
const includePortals = process.argv.includes("--portals") || includeDetail;

const CAPABILITIES = Object.freeze([
  ["REGISTRATION_OPEN",null],["CREDENTIAL_STORE",null],["CREDENTIAL_CHANGE",null],
  ["LOGIN_START","LOGIN"],["LOGIN_VERIFY","LOGIN"],["MFA_CONTINUE","MFA"],
  ["SESSION_STORE","LOGIN"],["PUBLIC_DOCUMENT_DOWNLOAD","DOCUMENT_DOWNLOAD"],
  ["PROTECTED_DOCUMENT_DOWNLOAD","DOCUMENT_DOWNLOAD"],["AMENDMENTS_DETECT","AMENDMENTS"],
  ["BIDDER_IDENTITY_CONFIRM","LOGIN"],["COMPANY_SELECT","PARTICIPATION"],
  ["TENDER_OPEN","DISCOVERY"],["LOT_OPEN","NOTICES"],
  ["SUBMISSION_PREFLIGHT","SUBMISSION_PREFLIGHT"],["PACKAGE_UPLOAD","SUBMISSION"],
  ["BINDING_SUBMIT","SUBMISSION"],["RECEIPT_DOWNLOAD","SUBMISSION"],
  ["SUBMISSION_STATUS","MONITORING"],
]);
const needsCredential = new Set(["LOGIN_START","LOGIN_VERIFY","MFA_CONTINUE","SESSION_STORE","PROTECTED_DOCUMENT_DOWNLOAD","BIDDER_IDENTITY_CONFIRM","COMPANY_SELECT","SUBMISSION_PREFLIGHT","PACKAGE_UPLOAD","BINDING_SUBMIT","RECEIPT_DOWNLOAD","SUBMISSION_STATUS"]);
const needsSession = new Set(["LOGIN_VERIFY","SESSION_STORE","PROTECTED_DOCUMENT_DOWNLOAD","BIDDER_IDENTITY_CONFIRM","COMPANY_SELECT","SUBMISSION_PREFLIGHT","PACKAGE_UPLOAD","BINDING_SUBMIT","RECEIPT_DOWNLOAD","SUBMISSION_STATUS"]);
const publicationCapabilities = new Set([
  "PUBLIC_DOCUMENT_DOWNLOAD","AMENDMENTS_DETECT","TENDER_OPEN","LOT_OPEN",
]);
const publicReadCapabilities = new Set(["PUBLIC_DOCUMENT_DOWNLOAD","TENDER_OPEN"]);

try {
  await client.query("BEGIN READ ONLY");
  const companies=await query(`SELECT company.company_id,company.legal_name,
      binding.tenant_id,binding.tenant_count,
      coalesce(scope.canonical_services,ARRAY[]::text[]) canonical_services,
      coalesce(scope.tender_scope_count,0)::int tender_scope_count,
      coalesce(scope.scope_tenant_count,0)::int scope_tenant_count,
      scope.scope_tenant_id
    FROM tender.enterprise_company_links company
    LEFT JOIN LATERAL (
      SELECT min(binding.tenant_id::text)::uuid tenant_id,
        count(DISTINCT binding.tenant_id)::int tenant_count
      FROM saas.legacy_company_tenant_bindings binding
      WHERE binding.company_id=company.company_id
    ) binding ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT scope.canonical_service ORDER BY scope.canonical_service)
          FILTER(WHERE scope.canonical_service IS NOT NULL) canonical_services,
        count(*)::int tender_scope_count,
        count(DISTINCT scope.tenant_id)::int scope_tenant_count,
        min(scope.tenant_id::text)::uuid scope_tenant_id
      FROM tender.configuration_scopes scope
      WHERE scope.company_id=company.company_id AND scope.profile_id=company.tender_profile_id
    ) scope ON true
    WHERE company.active
    ORDER BY company.legal_name`);
  const portals=await query(`WITH active_tender AS(
      SELECT id FROM tender.tenders WHERE data_class='PUBLIC_REAL' AND source_lifecycle_status='ACTIVE'
        AND wb_relevance_status IN('RELEVANT','REVIEW_REQUIRED') AND participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE')
        AND (offer_deadline IS NULL OR offer_deadline>now()))
    SELECT registry.id,registry.display_name,registry.canonical_domain,
      registry.portal_family_key,registry.adapter_id,registry.adapter_enabled,
      registry.adapter_validation_status,registry.entrypoint_type,
      coalesce(profile.portal_type,'UNCLASSIFIED') portal_type,
      registry.authentication_entry_url IS NOT NULL login_url,
      registry.registration_entry_url IS NOT NULL registration_url,
      registry.bidder_area_url IS NOT NULL bidder_area_url,sample.sample_url,
      (SELECT count(DISTINCT assignment.tender_id) FROM tender.tender_portal_assignments assignment JOIN active_tender tender ON tender.id=assignment.tender_id WHERE assignment.portal_id=registry.id AND assignment.status='ACTIVE' AND assignment.superseded_at IS NULL)::int active_assignments,
      (SELECT count(DISTINCT resolution.tender_id) FROM tender.tender_portal_resolutions resolution JOIN active_tender tender ON tender.id=resolution.tender_id WHERE resolution.portal_id=registry.id AND resolution.resolution_status='UNIQUE_EVIDENCE')::int active_resolutions,
      (SELECT count(DISTINCT link.tender_id) FROM tender.tender_external_links link JOIN active_tender tender ON tender.id=link.tender_id WHERE link.verification_status='VERIFIED' AND (lower(coalesce(link.final_host,link.original_host))=registry.canonical_domain OR lower(coalesce(link.final_host,link.original_host))=ANY(registry.allowed_subdomains)))::int active_official_links,
      (SELECT count(*) FROM tender.portal_credential_secrets secret JOIN tender.portal_credential_companies company ON company.credential_id=secret.id AND company.active WHERE secret.portal_id=registry.id AND secret.status='ACTIVE' AND (secret.valid_until IS NULL OR secret.valid_until>now()))::int active_credentials,
      (SELECT count(*) FROM tender.portal_connection_events event WHERE event.portal_id=registry.id AND event.occurred_at>=now()-interval '12 months')::int recent_events,
      EXISTS(SELECT 1 FROM tender.portal_connector_adapters connector WHERE connector.enabled AND connector.adapter_id=registry.adapter_id) active_connector,
      EXISTS(SELECT 1 FROM tender.scheduler_sources source WHERE source.enabled AND NOT source.kill_switch AND lower(source.source_code)=lower(registry.discovery_source)) active_source
    FROM tender.portal_registry registry
    LEFT JOIN tender.portal_capability_profiles profile ON profile.portal_id=registry.id
    LEFT JOIN LATERAL(SELECT coalesce(link.final_url,link.original_url) sample_url FROM tender.tender_external_links link
      WHERE lower(coalesce(link.final_host,link.original_host))=registry.canonical_domain OR lower(coalesce(link.final_host,link.original_host))=ANY(registry.allowed_subdomains)
      ORDER BY CASE WHEN coalesce(link.final_url,link.original_url)~*'/(VMP)?Satellite/notice/|/Vergabe/notice/|/NetServer(/|$)' THEN 0 ELSE 1 END,
        link.verified_at DESC NULLS LAST,link.created_at DESC LIMIT 1) sample ON true
    ORDER BY registry.canonical_domain,registry.display_name`);
  const operatorEvidence={"vergabe.bremen.de":"Administration Intelligence AG","vergabe.deges.de":"Administration Intelligence AG",
    "vergabe.hessen.de":"Administration Intelligence AG","vergabe.muenchen.de":"Administration Intelligence AG",
    "vergabekooperation.berlin":"Administration Intelligence AG","www.sachsen-vergabe.de":"Administration Intelligence AG"};
  const portalTruth=new Map(portals.map(portal=>{
    const family=observedPortalFamily({adapterId:portal.adapter_id,domain:portal.canonical_domain,
      sampleUrl:portal.sample_url,operatorEvidence:operatorEvidence[String(portal.canonical_domain).toLowerCase()]});
    const usage=portalOperationalRelevance({activeAssignments:portal.active_assignments,activeResolutions:portal.active_resolutions,
      activeOfficialLinks:portal.active_official_links,activeCredentials:portal.active_credentials,recentEvents:portal.recent_events,
      activeConnector:portal.active_connector,activeSource:portal.active_source});
    const internalEvidence=FAMILY_INTERNAL_REPLAY_EVIDENCE[family.familyKey]||null;
    return [String(portal.id),{familyKey:family.familyKey,operationallyRelevant:usage.relevant,
      relevanceReasons:usage.reasons,internalEvidence,adapterStatus:!usage.relevant?'INACTIVE_HISTORICAL_OR_THEORETICAL':
        internalEvidence?'INTERNALLY_READY':'ADAPTER_IMPLEMENTATION_REQUIRED'}];
  }));
  const hostCapabilityView=Boolean((await query("SELECT to_regclass('tender.current_portal_host_capability_truth') IS NOT NULL present"))[0]?.present);
  const featureRows=hostCapabilityView?await query(`SELECT portal_id,feature_key,portal_support,autopilot_supported,
      actively_configured,production_tested,browser_acceptance_passed
    FROM tender.current_portal_host_capability_truth`):await query(`SELECT NULL::uuid portal_id,portal_family_key,feature_key,
      portal_support,autopilot_supported,actively_configured,production_tested,browser_acceptance_passed
    FROM tender.current_portal_capability_truth`);
  const featureMap=new Map(featureRows.map(row=>[
    hostCapabilityView?`${row.portal_id}:${row.feature_key}`:`${row.portal_family_key}:${row.feature_key}`,row]));
  const featureFor=(portal,featureKey)=>featureMap.get(
    hostCapabilityView?`${portal.id}:${featureKey}`:`${portal.portal_family_key}:${featureKey}`);
  const featureImplemented=feature=>Boolean(feature&&feature.portal_support==="SUPPORTED"&&feature.autopilot_supported&&feature.actively_configured);
  const featureReady=feature=>Boolean(feature&&feature.portal_support==="SUPPORTED"&&feature.autopilot_supported&&
    feature.actively_configured&&feature.production_tested&&feature.browser_acceptance_passed);
  const credentialRows=await query(`SELECT scope.company_id,credential.portal_id,count(*)::int count,
      bool_or(credential.account_confirmed) account_confirmed,
      bool_or(credential.submission_capable) submission_capable,
      bool_and(credential.ciphertext IS NOT NULL AND credential.iv IS NOT NULL AND credential.auth_tag IS NOT NULL) encrypted
    FROM tender.portal_credential_companies scope JOIN tender.portal_credential_secrets credential ON credential.id=scope.credential_id
    WHERE scope.active AND credential.status='ACTIVE' AND (credential.valid_until IS NULL OR credential.valid_until>now())
    GROUP BY scope.company_id,credential.portal_id`);
  const credentialMap=new Map(credentialRows.map(row=>[`${row.company_id}:${row.portal_id}`,row]));
  const sessionRows=await query(`SELECT company_id,portal_id,count(*) FILTER(WHERE tender.portal_session_effective_status(status,expires_at,revoked_at,verification_status)='ACTIVE')::int active
    FROM tender.portal_read_sessions GROUP BY company_id,portal_id`);
  const sessionMap=new Map(sessionRows.map(row=>[`${row.company_id}:${row.portal_id}`,row]));
  const continuationRows=await query(`SELECT company_id,portal_id,
      bool_or(status='MFA_REQUIRED') mfa_required,
      bool_or(status='CAPTCHA_REQUIRED') captcha_required
    FROM tender.portal_login_continuations
    WHERE status IN('LOGIN_STARTED','WAITING_FOR_USER','MFA_REQUIRED','CAPTCHA_REQUIRED') GROUP BY company_id,portal_id`);
  const continuationMap=new Map(continuationRows.map(row=>[`${row.company_id}:${row.portal_id}`,row]));
  const migration122=Boolean((await query(`SELECT EXISTS(SELECT 1 FROM pg_policies
    WHERE schemaname='tender' AND tablename='portal_credential_secrets'
      AND policyname='runtime_insert_scope' AND cmd='INSERT') present`))[0]?.present);
  const submissionSafety=(await query(`SELECT external_submission_enabled,allow_external_submission,global_kill_switch FROM tender.submission_runtime_settings`))[0]||null;

  const matrix=[];
  for(const company of companies)for(const portal of portals){
    const key=`${company.company_id}:${portal.id}`,credential=credentialMap.get(key),session=sessionMap.get(key),continuation=continuationMap.get(key);
    const adapterTruth=portalTruth.get(String(portal.id));
    const capabilityStatuses={};
    const contextProblem=companyContextStatus(company);
    const requiredCapabilities=portal.portal_type==="BEKANNTMACHUNGSPLATTFORM"
      ? CAPABILITIES.filter(([capability])=>publicationCapabilities.has(capability))
      : CAPABILITIES;
    for(const [capability,featureKey] of requiredCapabilities){
      let status="READY",repair=null;
      if(!adapterTruth.operationallyRelevant){
        status="NOT_APPLICABLE_INACTIVE_PORTAL";
        repair="Portal ist historisch, theoretisch oder derzeit produktiv unbeobachtet; bei Reaktivierung wird die Familien- und Hostvalidierung neu ausgeführt.";
      }else if(contextProblem){
        status=contextProblem.status;
        repair=contextProblem.repair;
      }else if(portal.portal_type==="UNCLASSIFIED"){
        status="DATA_CONTEXT_REPAIR_REQUIRED";
        repair="Portalrolle anhand autoritativer Portal- und Ausschreibungsnachweise klassifizieren; erst danach die dafür erforderlichen Fähigkeiten bewerten.";
      }else if(capability==="REGISTRATION_OPEN"){
        status=portal.registration_url?"READY":"PORTAL_REGISTRATION_REQUIRED";
        repair=portal.registration_url?null:"Autorisierte Registrierungs-URL im Portalprofil belegen oder beim Portalbetreiber anfordern.";
      }else if(capability==="CREDENTIAL_STORE"||capability==="CREDENTIAL_CHANGE"){
        status=migration122?"READY":"DATA_CONTEXT_REPAIR_REQUIRED";
        repair=migration122?null:"Migration 0122 erneut anwenden und gesellschaftsscharfen RLS-Regressionstest ausführen.";
      }else if(featureKey&&!(needsCredential.has(capability)&&["LOGIN","MFA"].includes(featureKey)
        ?featureImplemented(featureFor(portal,featureKey)):featureReady(featureFor(portal,featureKey)))){
        status=adapterTruth.internalEvidence?"EXTERNAL_VALIDATION_PENDING":classifyPortalFeatureGap(portal,featureFor(portal,featureKey));
        repair=adapterTruth.internalEvidence?`Familienadapter ${adapterTruth.familyKey} ist intern contract-/replay-geprüft; Fähigkeit ${featureKey} ist nur noch mit Betreiberzugang hostbezogen nichtbindend zu zertifizieren.`:
          `Fähigkeit ${featureKey} für ${portal.canonical_domain} implementieren, konfigurieren sowie hostbezogen technisch und im Browser abnehmen.`;
      }else if(publicReadCapabilities.has(capability)){
        status="READY";repair=null;
      }else if(needsCredential.has(capability)&&!featureImplemented(featureFor(portal,"LOGIN"))){
        status=adapterTruth.internalEvidence?"EXTERNAL_VALIDATION_PENDING":classifyPortalFeatureGap(portal,featureFor(portal,"LOGIN"));
        repair=adapterTruth.internalEvidence?`Login-/Sitzungsfluss der intern geprüften Familie ${adapterTruth.familyKey} mit Betreiberzugang hostbezogen nichtbindend zertifizieren.`:
          `Login-/Sitzungsfähigkeit für ${portal.canonical_domain} implementieren und hostbezogen ohne bindende Portalaktion abnehmen.`;
      }else if(needsCredential.has(capability)&&!credential){
        status=portal.registration_url?"PORTAL_REGISTRATION_REQUIRED":"ACCOUNT_SETUP_REQUIRED";
        repair=portal.registration_url?"Gesellschaft über die verifizierte Registrierungsseite registrieren und Zugang anschließend verschlüsselt speichern.":"Gesellschaftskonto beim Portalbetreiber anlegen/freischalten und Zugang anschließend verschlüsselt speichern.";
      }else if(continuation?.captcha_required){
        status="MANUAL_CAPTCHA_REQUIRED";repair="CAPTCHA in der sicheren Fortsetzungsoberfläche manuell lösen; keine Umgehung zulässig.";
      }else if(continuation?.mfa_required){
        status="MANUAL_MFA_REQUIRED";repair="MFA in der sicheren Fortsetzungsoberfläche durch berechtigte Person bestätigen.";
      }else if(!portal.adapter_enabled){
        if(adapterTruth.internalEvidence){status="EXTERNAL_VALIDATION_PENDING";repair=`Intern geprüften Familienadapter ${adapterTruth.familyKey} für diesen Host betreiberseitig nichtbindend zertifizieren.`;}
        else{
        status=hasConcreteAdapterImplementation(portal)?"ADAPTER_REPAIR_REQUIRED":"UNSUPPORTED_PORTAL_REQUIRES_ADAPTER";repair=`Adapter nach Vertrag für ${portal.canonical_domain} implementieren und produktiv nichtbindend validieren.`;
        }
      }else if(portal.adapter_validation_status!=="PRODUCTION_VALIDATED"){
        status=adapterTruth.internalEvidence?"EXTERNAL_VALIDATION_PENDING":"ADAPTER_REPAIR_REQUIRED";
        repair=adapterTruth.internalEvidence?`Intern geprüften Familienadapter ${adapterTruth.familyKey} für diesen Host betreiberseitig nichtbindend zertifizieren.`:
          `Adapter ${portal.adapter_id||portal.canonical_domain} reparieren und Live-Read-/Preflight-Nachweis hinterlegen.`;
      }else{
        if(needsSession.has(capability)&&Number(session?.active||0)===0){
          status="ACCOUNT_SETUP_REQUIRED";repair="Login starten und eine verifizierte, verschlüsselte gesellschaftsscharfe Sitzung herstellen.";
        }
      }
      capabilityStatuses[capability]={status,repair};
    }
    const statuses=Object.values(capabilityStatuses).map(item=>item.status);
    matrix.push({companyId:company.company_id,company:company.legal_name,tenantId:company.tenant_id,
      portalId:portal.id,portal:portal.display_name,domain:portal.canonical_domain,portalFamily:portal.portal_family_key,
      observedPortalFamily:adapterTruth.familyKey,adapterStatus:adapterTruth.adapterStatus,
      adapterId:portal.adapter_id,credentialConfigured:Boolean(credential),effectiveSession:Number(session?.active||0)>0,
      portalRole:portal.portal_type,requiredCapabilityCount:requiredCapabilities.length,
      overall:statuses.every(value=>value==="NOT_APPLICABLE_INACTIVE_PORTAL")?"NOT_APPLICABLE_INACTIVE_PORTAL":statuses.every(value=>value==="READY")?"READY":statuses.includes("DATA_CONTEXT_REPAIR_REQUIRED")?"DATA_CONTEXT_REPAIR_REQUIRED":statuses.includes("MANUAL_CAPTCHA_REQUIRED")?"MANUAL_CAPTCHA_REQUIRED":statuses.includes("MANUAL_MFA_REQUIRED")?"MANUAL_MFA_REQUIRED":statuses.includes("UNSUPPORTED_PORTAL_REQUIRES_ADAPTER")?"UNSUPPORTED_PORTAL_REQUIRES_ADAPTER":statuses.includes("ADAPTER_REPAIR_REQUIRED")?"ADAPTER_REPAIR_REQUIRED":statuses.includes("EXTERNAL_VALIDATION_PENDING")?"EXTERNAL_VALIDATION_PENDING":statuses.includes("PORTAL_REGISTRATION_REQUIRED")?"PORTAL_REGISTRATION_REQUIRED":"ACCOUNT_SETUP_REQUIRED",
      capabilities:capabilityStatuses});
  }
  const summary={};
  for(const row of matrix){summary[row.company]??={};summary[row.company][row.overall]=(summary[row.company][row.overall]||0)+1}
  const capabilityStatusTotals={};
  for(const row of matrix)for(const [capability,result] of Object.entries(row.capabilities)){
    capabilityStatusTotals[capability]??={};
    capabilityStatusTotals[capability][result.status]=(capabilityStatusTotals[capability][result.status]||0)+1;
  }
  const portalSummary=portals.map(portal=>{
    const rows=matrix.filter(row=>row.portalId===portal.id),statuses={};
    for(const row of rows)statuses[row.overall]=(statuses[row.overall]||0)+1;
    return {portalId:portal.id,portal:portal.display_name,domain:portal.canonical_domain,
      portalFamily:portal.portal_family_key,adapterId:portal.adapter_id,
      adapterEnabled:portal.adapter_enabled,adapterValidationStatus:portal.adapter_validation_status,
      loginUrlConfigured:portal.login_url,registrationUrlConfigured:portal.registration_url,
      companyStatuses:statuses};
  });
  const portalInventoryTotals={};
  for(const portal of portals){
    const key=`${portal.portal_type}:${portal.adapter_enabled?"ENABLED":"DISABLED"}:${portal.adapter_validation_status}`;
    portalInventoryTotals[key]=(portalInventoryTotals[key]||0)+1;
  }
  const familyAdapterReadiness=[...new Set([...portalTruth.values()].map(truth=>truth.familyKey))].map(familyKey=>{
    const members=[...portalTruth.values()].filter(truth=>truth.familyKey===familyKey),
      operationallyRelevant=members.some(truth=>truth.operationallyRelevant),
      internalEvidence=FAMILY_INTERNAL_REPLAY_EVIDENCE[familyKey]||null;
    return {familyKey,status:!operationallyRelevant?'INACTIVE_HISTORICAL_OR_THEORETICAL':
      internalEvidence?'INTERNALLY_READY':'ADAPTER_IMPLEMENTATION_REQUIRED',internalEvidence,operationallyRelevant};
  }).sort((a,b)=>a.familyKey.localeCompare(b.familyKey));
  const companyConfiguration=companies.map(company=>({companyId:company.company_id,company:company.legal_name,
    status:companyContextStatus(company)?.status||'READY',tenantId:company.tenant_id,canonicalServices:company.canonical_services}));
  await client.query("ROLLBACK");
  console.log(JSON.stringify({capturedAt:new Date().toISOString(),transaction:"READ_ONLY_ROLLED_BACK",companies,
    portalCount:portals.length,hostSpecificCapabilityEvidence:hostCapabilityView,
    portalInventoryTotals,familyAdapterReadiness,companyConfiguration,portalSummary:includePortals?portalSummary:undefined,
    capabilityCount:CAPABILITIES.length,combinations:matrix.length,capabilityStatusTotals,
    summary,submissionSafety,matrix:includeDetail?matrix:undefined},null,2));
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{await client.release();await rawPool.end()}
