import {PORTAL_ADAPTER_CATALOG} from "./portal-adapter-catalog.mjs";

export const COMPANY_CONFIGURATION_CAPABILITIES=Object.freeze([
  "REGISTRATION_OPEN","CREDENTIAL_STORE","CREDENTIAL_CHANGE","BIDDER_IDENTITY_CONFIRM",
  "COMPANY_SELECT","TENDER_LOT_BINDING","APPROVAL_ACCOUNT_BINDING",
]);

export const FAMILY_ADAPTER_CAPABILITIES=Object.freeze([
  "LOGIN_START","LOGIN_VERIFY","MFA_CAPTCHA_CONTINUE","SESSION_STORE",
  "PUBLIC_DOCUMENT_DOWNLOAD","PROTECTED_DOCUMENT_DOWNLOAD","AMENDMENTS_DETECT",
  "TENDER_OPEN","LOT_OPEN","SUBMISSION_PREFLIGHT","PACKAGE_UPLOAD","BINDING_SUBMIT",
  "RECEIPT_DOWNLOAD","SUBMISSION_STATUS",
]);

export const INTERNAL_PLATFORM_CAPABILITIES=Object.freeze([
  "TENDER_LOT_CONTEXT","PORTAL_RESOLUTION","CREDENTIAL_ENCRYPTION","RLS_TENANT_ISOLATION",
  "DOCUMENT_PIPELINE","REQUIREMENT_ANALYSIS","REQUIRED_DOCUMENTS","CALCULATION",
  "FORM_EDITING","DURABLE_SAVE","APPROVAL_WORKFLOW","PACKAGE_BUILDING",
  "SUBMISSION_IDEMPOTENCY","RECEIPT_PROCESSING",
]);

export const FAMILY_INTERNAL_REPLAY_EVIDENCE=Object.freeze(Object.fromEntries([
  "ai-vergabe-manager","aumass","bi-medien","cosinex","deutsche-evergabe","dtvp",
  "etenders-ireland","eu-funding-tenders","evergabe-bayern","evergabe-de","evergabe-online-bund",
  "mercell-s2c","rib-meinauftrag","subreport","ted","vergabe24",
].map(familyKey=>[familyKey,Object.freeze({suite:"portal-family-full-contract-matrix/1.0.0",release:"20260826-readiness-consolidation-131.31",
  readCapabilitiesComplete:true,submissionProtocolImplemented:true,mockReplayContractPassed:true,externalWrite:false,transmitted:false})])));

const ALIASES=Object.freeze({
  "ted-discovery":"ted",
  "cosinex-vmp-public":"cosinex",
  "cosinex-vmp":"cosinex",
  "subreport-elvis":"subreport",
  "ai-netserver-duesseldorf":"ai-vergabe-manager",
  "ai-vmstart-saarvpsl":"ai-vergabe-manager",
  "eu-funding-tenders":"eu-funding-tenders",
  "etenders-ireland":"etenders-ireland",
});

const normalized=value=>String(value||"").trim().toLowerCase();
export function canonicalImplementedFamily(adapterId){
  const value=normalized(adapterId);
  if(!value||value.startsWith("unknown-"))return null;
  return ALIASES[value]||value;
}

export function observedPortalFamily({adapterId,domain,sampleUrl,operatorEvidence}={}){
  const implemented=canonicalImplementedFamily(adapterId);
  if(implemented)return {familyKey:implemented,evidence:"IMPLEMENTED_ADAPTER_ID",confidence:"AUTHORITATIVE"};
  const url=String(sampleUrl||"");
  if(/\/(?:VMP)?Satellite\/notice\//i.test(url)||/\/Vergabe\/notice\//i.test(url))
    return {familyKey:"cosinex",evidence:"OBSERVED_COSINEX_NOTICE_PATH",confidence:"TECHNICALLY_OBSERVED"};
  if(/\/NetServer(?:\/|$)/i.test(url))
    return {familyKey:"ai-vergabe-manager",evidence:"OBSERVED_NETSERVER_PATH",confidence:"TECHNICALLY_OBSERVED"};
  if(normalized(operatorEvidence)==="administration intelligence ag")
    return {familyKey:"ai-vergabe-manager",evidence:"VERIFIED_OPERATOR_EVIDENCE",confidence:"AUTHORITATIVE"};
  if(normalized(domain)==="www.vergabe.rib.de")
    return {familyKey:"rib-meinauftrag",evidence:"VERIFIED_OPERATOR_DOMAIN",confidence:"TECHNICALLY_OBSERVED"};
  if(normalized(domain)==="bi-medien.de")
    return {familyKey:"bi-medien",evidence:"CATALOG_AND_EXACT_DOMAIN",confidence:"TECHNICALLY_OBSERVED"};
  return {familyKey:`unresolved:${normalized(domain)}`,evidence:"NO_FAMILY_EVIDENCE",confidence:"UNRESOLVED"};
}

const catalogFamilies=new Set(PORTAL_ADAPTER_CATALOG.map(item=>canonicalImplementedFamily(item.adapterId)));
export function codeAdapterImplemented(familyKey,dbAdapterCodes=[]){
  const family=canonicalImplementedFamily(familyKey)||normalized(familyKey);
  return catalogFamilies.has(family)||dbAdapterCodes.some(code=>canonicalImplementedFamily(code)===family);
}

export function portalOperationalRelevance(usage={}){
  const reasons=[];
  if(Number(usage.activeAssignments)>0)reasons.push("ACTIVE_TENDER_ASSIGNMENT");
  if(Number(usage.activeResolutions)>0)reasons.push("ACTIVE_TENDER_RESOLUTION");
  if(Number(usage.activeOfficialLinks)>0)reasons.push("ACTIVE_OFFICIAL_LINK");
  if(Number(usage.activeCredentials)>0)reasons.push("ACTIVE_COMPANY_CREDENTIAL");
  if(Number(usage.recentEvents)>0)reasons.push("USED_WITHIN_TWELVE_MONTHS");
  if(usage.activeConnector===true)reasons.push("ACTIVE_CONNECTOR");
  if(usage.activeSource===true)reasons.push("ACTIVE_SOURCE");
  return {relevant:reasons.length>0,reasons};
}

export function familyAdapterMaturity({familyKey,dbAdapterCodes=[],readCapabilitiesComplete=false,
  submissionProtocolImplemented=false,mockReplayContractPassed=false}={}){
  const implemented=codeAdapterImplemented(familyKey,dbAdapterCodes);
  if(!implemented)return {status:"ADAPTER_IMPLEMENTATION_REQUIRED",implemented:false,internallyTested:false};
  if(!readCapabilitiesComplete||!submissionProtocolImplemented||!mockReplayContractPassed)
    return {status:"ADAPTER_IMPLEMENTATION_REQUIRED",implemented:true,internallyTested:false};
  return {status:"INTERNALLY_READY",implemented:true,internallyTested:true};
}
