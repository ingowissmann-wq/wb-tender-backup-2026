import {domainToASCII} from "node:url";
import {lookup} from "node:dns/promises";
import crypto from "node:crypto";
import {authorizeDocumentAccessRegistration} from "./document-access-governance.mjs";

export const CONNECTOR_CONTRACT_VERSION="1.0.0";
export const PORTAL_ADAPTER_CONTRACT_VERSION="2.0.0";
export const PORTAL_ADAPTER_OPERATIONS=Object.freeze([
  "DISCOVER","LOGIN","MFA","NAVIGATE","EXPAND_DOCUMENT_TREE","FOLLOW_PARTNER_SYSTEM",
  "DOWNLOAD","CLASSIFY","EXTRACT","RETRY","DOCUMENT_ACCESS_REGISTRATION","PARTICIPATE","VALIDATE_SESSION","LIST_DOCUMENTS",
  "RESOLVE_DOWNLOAD_ACTION","VERIFY_DOCUMENT_CONTENT","MAP_TENDER_AND_LOT","RESUME_AFTER_LOGIN","HEALTHCHECK"
]);
export const PORTAL_ADAPTER_READ_OPERATIONS=new Set(PORTAL_ADAPTER_OPERATIONS.filter(value=>!["PARTICIPATE","DOCUMENT_ACCESS_REGISTRATION"].includes(value)));
export const PORTAL_AUTOMATION_MODES=Object.freeze({READ_ONLY:"READ_ONLY_PORTAL_AUTOMATION",PARTICIPATION:"EXTERNAL_PARTICIPATION_ACTION"});
export const PORTAL_MEMBERSHIP_STATUSES=Object.freeze(new Set([
  "ACTIVE_SUBSCRIPTION","ACTIVE_SUBSCRIPTION_SCOPE_MATCH","ACTIVE_SUBSCRIPTION_SCOPE_MISMATCH",
  "PUBLIC_CONTEXT_ONLY","WRONG_ORGANIZATION_CONTEXT","SESSION_EXPIRED","ACTUAL_UPGRADE_REQUIRED"
]));
export function classifyPortalMembership({sessionActive=false,authenticated=false,organizationMatches=true,subscriptionActive=false,subscriptionScopes=[],targetScope=null,upgradeGate=false}={}){
  if(!sessionActive)return "SESSION_EXPIRED";
  if(!authenticated)return "PUBLIC_CONTEXT_ONLY";
  if(!organizationMatches)return "WRONG_ORGANIZATION_CONTEXT";
  if(subscriptionActive){
    if(!targetScope)return "ACTIVE_SUBSCRIPTION";
    return subscriptionScopes.map(value=>String(value).trim().toUpperCase()).includes(String(targetScope).trim().toUpperCase())?"ACTIVE_SUBSCRIPTION_SCOPE_MATCH":"ACTIVE_SUBSCRIPTION_SCOPE_MISMATCH";
  }
  return upgradeGate?"ACTUAL_UPGRADE_REQUIRED":"PUBLIC_CONTEXT_ONLY";
}
export const PORTAL_ERROR_CLASSES=new Set([
  "LOGIN_REQUIRED","MFA_REQUIRED","SESSION_EXPIRED","CREDENTIALS_NOT_CONFIGURED","PORTAL_UNREACHABLE",
  "DOWNLOAD_LINK_UNRESOLVED","EXTERNAL_DOCUMENT_REQUEST_REQUIRED","DOCUMENT_NOT_FOUND","ACCESS_DENIED",
  "LOGIN_PAGE_RETURNED_AS_DOCUMENT","MIME_TYPE_INVALID","ZIP_INVALID","PARSER_FAILED","RATE_LIMITED",
  "TIMEOUT","PARTNER_SYSTEM_NOT_ALLOWED","TENDER_LOT_ASSIGNMENT_UNRESOLVED","BOARD_APPROVAL_REQUIRED",
  "EXTERNAL_ACTION_LOCKED","PARTICIPATION_NOT_IMPLEMENTED_BY_ADAPTER","ADAPTER_OPERATION_FAILED"
]);
const defaultTimeouts=Object.freeze({LOGIN:60_000,MFA:180_000,DOWNLOAD:120_000,EXPAND_DOCUMENT_TREE:120_000,PARTICIPATE:120_000,DEFAULT:30_000});
const INTERNAL_OUTPUT=Symbol("portalOperationInternalOutput");
const digest=value=>crypto.createHash("sha256").update(JSON.stringify(value??null)).digest("hex");
const errorClass=error=>{const code=String(error?.code||error?.message||"ADAPTER_OPERATION_FAILED").toUpperCase();return PORTAL_ERROR_CLASSES.has(code)?code:code.includes("TIMEOUT")?"TIMEOUT":"ADAPTER_OPERATION_FAILED"};
export const CAPABILITIES=Object.freeze([
  "LOGIN_HTTP_FORM","LOGIN_BROWSER_REQUIRED","LOGIN_SSO","LOGIN_OIDC","LOGIN_KEYCLOAK","LOGIN_SAML",
  "CSRF_REQUIRED","CONSENT_REQUIRED","JAVASCRIPT_REQUIRED","MFA_POSSIBLE","CAPTCHA_POSSIBLE",
  "TENDER_SEARCH_SUPPORTED","DIRECT_TENDER_LINK_SUPPORTED","DOCUMENT_LIST_SUPPORTED","DIRECT_DOWNLOAD_SUPPORTED",
  "POST_DOWNLOAD_SUPPORTED","XHR_DOWNLOAD_SUPPORTED","ZIP_DOWNLOAD_SUPPORTED","SESSION_REFRESH_SUPPORTED",
  "DOWNLOAD_HOST_DIFFERENT_DOMAIN","PUBLIC_DOCUMENTS_POSSIBLE","AUTHENTICATED_DOCUMENTS_REQUIRED"
]);
export const VALIDATION_STATUSES=new Set(["ADAPTER_VALIDATED_BUT_DEGRADED","LIVE_VALIDATED","ADAPTER_REPAIR_REQUIRED","CREDENTIAL_REQUIRED","MFA_REQUIRED","CAPTCHA_REQUIRED","TEMPORARILY_UNAVAILABLE","UNKNOWN_PORTAL_ADAPTER_REQUIRED"]);
export const DOCUMENT_TEST_ZERO_CODES=new Set(["KEINE_DOKUMENTE_VORHANDEN","KEINE_PASSENDE_AUSSCHREIBUNG_GEFUNDEN","DOKUMENTENLISTE_NICHT_ERMITTELT","DOKUMENTENBERECHTIGUNG_FEHLT","DOWNLOADLINK_NICHT_AUFGELOEST","SESSION_NICHT_FUER_DOWNLOAD_GUELTIG","EXTERNAL_DOCUMENT_REQUEST_REQUIRED"]);

const privateAddress=value=>/^(?:127\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i.test(value);
const asciiHost=value=>{const host=domainToASCII(String(value||"").trim().replace(/\.$/,"").toLowerCase());if(!host||host.includes("..")||host.startsWith(".")||host.endsWith("."))throw new Error("PORTAL_HOST_INVALID");return host};
const exactHost=(candidate,allowed)=>allowed.some(value=>candidate===asciiHost(value));
export async function assertPublicPortalHost(host,{lookupImpl=lookup}={}){const normalized=asciiHost(host);const answers=await lookupImpl(normalized,{all:true,verbatim:true});if(!answers.length||answers.some(item=>privateAddress(item.address)))throw new Error("PORTAL_DNS_TARGET_FORBIDDEN");return normalized}

export function normalizeAdapterRecord(record){
  const capabilities=[...new Set(record.capabilities||[])];
  if(capabilities.some(value=>!CAPABILITIES.includes(value)))throw new Error("PORTAL_CAPABILITY_INVALID");
  const canonicalDomain=asciiHost(record.canonical_domain);
  return {...record,canonical_domain:canonicalDomain,authentication_domains:[...new Set(record.authentication_domains||[])].map(asciiHost),download_domains:[...new Set(record.download_domains||[])].map(asciiHost),capabilities};
}

export function allowedRedirect(url,adapter,{priorUrl=null,expectedState=null,maxRedirectsSeen=0}={}){
  const profile=normalizeAdapterRecord(adapter),target=new URL(url,priorUrl||`https://${profile.canonical_domain}/`);
  if(target.protocol!=="https:"||target.username||target.password||maxRedirectsSeen>=Number(profile.max_redirects||8))throw new Error("LOGIN_REDIRECT_UNERWARTET");
  const host=asciiHost(target.hostname),hosts=[profile.canonical_domain,...profile.authentication_domains,...profile.download_domains];
  if(!exactHost(host,hosts))throw new Error("LOGIN_REDIRECT_UNERWARTET");
  if(expectedState&&target.searchParams.has("state")&&target.searchParams.get("state")!==expectedState)throw new Error("LOGIN_REDIRECT_STATE_UNGUELTIG");
  target.hash="";
  return target;
}

export class PortalConnectorContract {
  constructor(profile){this.profile=normalizeAdapterRecord(profile)}
  get contractVersion(){return PORTAL_ADAPTER_CONTRACT_VERSION}
  get operations(){return PORTAL_ADAPTER_OPERATIONS}
  async DISCOVER(context){return {portalDetected:this.detectPortal(context.url),portal:this.profile.adapter_id,sourceUrl:context.url}}
  async LOGIN(context){
    const session=await this.initializeSession(context);
    const form=await this.detectLoginForm(session,context);
    if(!form){const publicAccess=this.profile.login_strategy==="SOURCE_RESOLVER"||this.profile.capabilities.includes("PUBLIC_DOCUMENTS_POSSIBLE");return {status:await this.detectLoginSuccess(session,context)?"LOGIN_SUCCEEDED":publicAccess?"NOT_REQUIRED":"LOGIN_REQUIRED",session}}
    if(!context.credential)return {status:"CREDENTIALS_NOT_CONFIGURED",session};
    await this.submitCredentials(session,context.credential,form,context);
    return {status:await this.detectLoginSuccess(session,context)?"LOGIN_SUCCEEDED":"LOGIN_REQUIRED",session};
  }
  async MFA(context){return {status:await this.detectMfa(context.session,context)?"MFA_REQUIRED":"NOT_REQUIRED",session:context.session}}
  async NAVIGATE(context){await this.openTenderSearch(context);await this.locateTender(context);return this.openTenderDetail(context)}
  async EXPAND_DOCUMENT_TREE(context){await this.openDocumentArea(context);return this.listDocuments(context)}
  async FOLLOW_PARTNER_SYSTEM(context){return {followed:false,reason:"NO_PARTNER_SYSTEM_DETECTED",context}}
  async DOWNLOAD(context){const action=await this.resolveDownloadAction(context.document,context);return this.downloadDocument(action,context)}
  async CLASSIFY(context){if(typeof context.classifyDocument!=="function")throw new Error("CLASSIFIER_NOT_CONFIGURED");return context.classifyDocument(context.document)}
  async EXTRACT(context){if(typeof context.extractDocument!=="function")throw new Error("EXTRACTOR_NOT_CONFIGURED");return context.extractDocument(context.document)}
  async RETRY(context){if(context.attempt>=context.maxAttempts)throw new Error("RETRY_EXHAUSTED");const base=Math.min(3_600_000,Math.max(1_000,Number(context.baseDelayMs||1_000))*2**Math.max(0,Number(context.attempt||0)));const jitter=Math.floor(base*.2*(Number(context.random?.()??Math.random())*2-1));return {retryAt:new Date(Date.now()+base+jitter).toISOString(),delayMs:base+jitter}}
  async VALIDATE_SESSION(context){const success=await this.detectLoginSuccess(context.session,context);return {valid:Boolean(success),status:success?"SESSION_VALID":"SESSION_EXPIRED"}}
  async LIST_DOCUMENTS(context){return this.listDocuments(context)}
  async RESOLVE_DOWNLOAD_ACTION(context){return this.resolveDownloadAction(context.document,context)}
  async VERIFY_DOCUMENT_CONTENT(context){return {verified:Boolean(await this.verifyDownloadedFile(context.document,context)),document:context.document}}
  async MAP_TENDER_AND_LOT(context){if(typeof context.mapTenderAndLot!=="function")throw Object.assign(new Error("TENDER_LOT_ASSIGNMENT_UNRESOLVED"),{code:"TENDER_LOT_ASSIGNMENT_UNRESOLVED"});return context.mapTenderAndLot(context.document,context)}
  async RESUME_AFTER_LOGIN(context){const session=await this.VALIDATE_SESSION(context);if(!session.valid)return {status:session.status,resumed:false};if(typeof context.enqueueContinuation!=="function")throw new Error("CONTINUATION_QUEUE_NOT_CONFIGURED");return {status:"RESUMED",resumed:true,job:await context.enqueueContinuation(context)}}
  async HEALTHCHECK(context={}){return {healthy:true,adapterId:this.profile.adapter_id,contractVersion:this.contractVersion,readOnly:context.mode!==PORTAL_AUTOMATION_MODES.PARTICIPATION}}
  async DOCUMENT_ACCESS_REGISTRATION(context){
    const decision=authorizeDocumentAccessRegistration({...context,portalAdapterId:context.portalAdapterId||this.profile.adapter_id});
    if(!decision.authorized)throw Object.assign(new Error(decision.reason),{code:"EXTERNAL_ACTION_LOCKED",decision});
    if(typeof context.executeDocumentAccessRegistration!=="function")throw Object.assign(new Error("PARTICIPATION_NOT_IMPLEMENTED_BY_ADAPTER"),{code:"PARTICIPATION_NOT_IMPLEMENTED_BY_ADAPTER"});
    return {...await context.executeDocumentAccessRegistration({...context,decision}),decision};
  }
  async PARTICIPATE(context){
    if(context?.approval?.status!=="APPROVED"||context.approval.mfaVerified!==true||context.approval.payloadSha256!==context.payloadSha256)throw Object.assign(new Error("BOARD_APPROVAL_REQUIRED"),{code:"BOARD_APPROVAL_REQUIRED"});
    if(context.externalActionsEnabled!==true||context.killSwitch!==false)throw Object.assign(new Error("EXTERNAL_ACTION_LOCKED"),{code:"EXTERNAL_ACTION_LOCKED"});
    throw Object.assign(new Error("PARTICIPATION_NOT_IMPLEMENTED_BY_ADAPTER"),{code:"PARTICIPATION_NOT_IMPLEMENTED_BY_ADAPTER"});
  }
  detectPortal(){return false}
  resolveCanonicalDomain(){return this.profile.canonical_domain}
  resolveAuthenticationDomains(){return this.profile.authentication_domains}
  getLoginEntryPoint(){return this.profile.login_entry_point||null}
  async initializeSession(){throw new Error("ADAPTER_REPAIR_REQUIRED")}
  async handleConsent(context){return context}
  async extractCsrf(){return null}
  async detectLoginForm(){return null}
  async submitCredentials(){throw new Error("ADAPTER_REPAIR_REQUIRED")}
  followAllowedRedirects(url,context){return allowedRedirect(url,this.profile,context)}
  async detectLoginSuccess(){return false}
  async detectLoginFailure(){return null}
  async detectMfa(){return false}
  async detectCaptcha(){return false}
  async openTenderSearch(){throw new Error("ADAPTER_REPAIR_REQUIRED")}
  async locateTender(){throw new Error("ADAPTER_REPAIR_REQUIRED")}
  async openTenderDetail(){throw new Error("ADAPTER_REPAIR_REQUIRED")}
  async openDocumentArea(){throw new Error("ADAPTER_REPAIR_REQUIRED")}
  async listDocuments(){throw new Error("DOKUMENTENLISTE_NICHT_ERMITTELT")}
  async resolveDownloadAction(){throw new Error("DOWNLOADLINK_NICHT_AUFGELOEST")}
  async downloadDocument(){throw new Error("DOWNLOADLINK_NICHT_AUFGELOEST")}
  async verifyDownloadedFile(){return false}
  async refreshSession(){throw new Error("SESSION_NICHT_FUER_DOWNLOAD_GUELTIG")}
  async logoutOrDestroySession(){}
  produceSafeDiagnostic(error,extra={}){return safeDiagnostic({adapterId:this.profile.adapter_id,adapterVersion:this.profile.adapter_version,errorCode:error?.code||error?.message||"TECHNISCHER_CONNECTORFEHLER",...extra})}
}

export async function executePortalOperation(adapter,operation,context={}){
  validatePortalAdapterContract(adapter);if(!PORTAL_ADAPTER_OPERATIONS.includes(operation))throw new Error("PORTAL_OPERATION_INVALID");
  const startedAt=new Date(),timeoutMs=Math.max(1_000,Number(context.timeoutMs||adapter.profile?.timeout_profile?.[operation]||defaultTimeouts[operation]||defaultTimeouts.DEFAULT));
  const idempotencyKey=String(context.idempotencyKey||digest({adapterId:adapter.profile?.adapter_id,operation,tenderId:context.tenderId||null,lotKey:context.lotKey||null,documentId:context.documentId||context.document?.id||null,version:context.version||null}));
  const auditBase={adapterId:adapter.profile?.adapter_id,adapterVersion:adapter.profile?.adapter_version,contractVersion:adapter.contractVersion,operation,mode:context.mode||PORTAL_AUTOMATION_MODES.READ_ONLY,tenderId:context.tenderId||null,lotKey:context.lotKey||null,portalId:context.portalId||null,idempotencyKey,attempt:Number(context.attempt||0),startedAt:startedAt.toISOString(),timeoutMs};
  let timer;try{
    const output=await Promise.race([adapter[operation](context),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error("TIMEOUT"),{code:"TIMEOUT"})),timeoutMs)})]);
    const result={ok:true,status:"SUCCEEDED",operation,idempotencyKey,output:safeDiagnostic(output),error:null,retry:null,audit:{...auditBase,finishedAt:new Date().toISOString()}};Object.defineProperty(result,INTERNAL_OUTPUT,{value:output});await context.audit?.(result.audit);return result;
  }catch(error){const code=errorClass(error),retryable=!new Set(["CREDENTIALS_NOT_CONFIGURED","MFA_REQUIRED","EXTERNAL_DOCUMENT_REQUEST_REQUIRED","DOCUMENT_NOT_FOUND","ACCESS_DENIED","TENDER_LOT_ASSIGNMENT_UNRESOLVED","BOARD_APPROVAL_REQUIRED","EXTERNAL_ACTION_LOCKED"]).has(code),result={ok:false,status:"FAILED",operation,idempotencyKey,output:null,error:{class:code,detail:safeDiagnostic(String(error?.message||code))},retry:{retryable,maxAttempts:Number(context.maxAttempts||3),attempt:Number(context.attempt||0)},audit:{...auditBase,errorClass:code,finishedAt:new Date().toISOString()}};await context.audit?.(result.audit);return result}finally{clearTimeout(timer)}
}

export function validatePortalAdapterContract(adapter){
  if(!adapter||typeof adapter!=="object")throw new Error("PORTAL_ADAPTER_REQUIRED");
  const missing=PORTAL_ADAPTER_OPERATIONS.filter(operation=>typeof adapter[operation]!=="function");
  if(missing.length)throw Object.assign(new Error("PORTAL_ADAPTER_CONTRACT_INCOMPLETE"),{code:"PORTAL_ADAPTER_CONTRACT_INCOMPLETE",missing});
  return {valid:true,contractVersion:adapter.contractVersion||PORTAL_ADAPTER_CONTRACT_VERSION,operations:[...PORTAL_ADAPTER_OPERATIONS]};
}

export async function runPortalReadLifecycle(adapter,context={}){
  validatePortalAdapterContract(adapter);
  const trace=[],run=async(operation,input)=>{const envelope=await executePortalOperation(adapter,operation,{...input,mode:PORTAL_AUTOMATION_MODES.READ_ONLY});trace.push(envelope.audit);if(!envelope.ok)throw Object.assign(new Error(envelope.error.class),{code:envelope.error.class,portalTrace:trace});return envelope[INTERNAL_OUTPUT]};
  const discovered=await run("DISCOVER",context),login=await run("LOGIN",{...context,discovered});
  if(!["LOGIN_SUCCEEDED","NOT_REQUIRED"].includes(login.status))return {status:login.status,trace,discovered};
  const mfa=await run("MFA",{...context,...login});if(mfa.status==="MFA_REQUIRED")return {status:"MFA_REQUIRED",trace,discovered};
  const tender=await run("NAVIGATE",{...context,...login,mfa}),documents=await run("EXPAND_DOCUMENT_TREE",{...context,...login,mfa,tender});
  const partner=await run("FOLLOW_PARTNER_SYSTEM",{...context,...login,mfa,tender,documents});
  return {status:"DOCUMENT_TREE_EXPANDED",trace,discovered,tender,documents,partner};
}

export class SourceResolverConnector extends PortalConnectorContract {
  detectPortal(url){const host=asciiHost(new URL(url).hostname);return exactHost(host,[this.profile.canonical_domain,...this.profile.authentication_domains,...this.profile.download_domains])}
  async initializeSession(){return {readOnly:true,sourceResolver:true}}
  async logoutOrDestroySession(session){if(session)for(const key of Object.keys(session))session[key]=null}
}

export class GenericHttpConnector extends PortalConnectorContract {
  detectPortal(url){return exactHost(asciiHost(new URL(url).hostname),[this.profile.canonical_domain,...this.profile.authentication_domains,...this.profile.download_domains])}
  async initializeSession(){return {cookies:new Map(),createdAt:Date.now(),readOnly:true}}
  async logoutOrDestroySession(session){session?.cookies?.clear();if(session)for(const key of Object.keys(session))session[key]=null}
}

export class ProtocolReplayConnector extends GenericHttpConnector {
  async initializeSession(context={}){return {cookies:new Map(),createdAt:Date.now(),readOnly:true,authenticated:Boolean(context.snapshot?.authenticated)}}
  async detectLoginForm(_session,context={}){return context.snapshot?.loginRequired?{username:true,password:true,csrf:Boolean(context.snapshot?.csrf)}:null}
  async submitCredentials(session,credential,_form,context={}){if(!credential?.username||!credential?.password)throw new Error("CREDENTIALS_NOT_CONFIGURED");session.authenticated=context.snapshot?.credentialOutcome==="SUCCESS";return session}
  async detectLoginSuccess(session,context={}){return Boolean(session?.authenticated||context.snapshot?.authenticated||context.snapshot?.publicAccess)}
  async detectMfa(_session,context={}){return Boolean(context.snapshot?.mfaRequired)}
  async detectCaptcha(_session,context={}){return Boolean(context.snapshot?.captchaRequired)}
  async openTenderSearch(context={}){return {status:"SEARCH_OPEN",query:context.externalId||context.tenderId||null}}
  async locateTender(context={}){if(!context.snapshot?.tender)throw new Error("TENDER_LOT_ASSIGNMENT_UNRESOLVED");return context.snapshot.tender}
  async openTenderDetail(context={}){return context.snapshot?.tender||this.locateTender(context)}
  async openDocumentArea(context={}){return {status:"DOCUMENT_AREA_OPEN",tender:context.snapshot?.tender||null}}
  async listDocuments(context={}){return (context.snapshot?.documents||[]).map(document=>{const target=this.followAllowedRedirects(document.url,{priorUrl:`https://${this.profile.canonical_domain}/`,maxRedirectsSeen:0});return {id:String(document.id||""),name:String(document.name||""),url:target.href,protected:Boolean(document.protected),amendment:Boolean(document.amendment)}})}
  async resolveDownloadAction(document){if(!document?.url)throw new Error("DOWNLOAD_LINK_UNRESOLVED");return {method:"GET",url:this.followAllowedRedirects(document.url,{priorUrl:`https://${this.profile.canonical_domain}/`,maxRedirectsSeen:0}).href,document}}
  async downloadDocument(action,context={}){if(typeof context.fetchDocument!=="function")throw new Error("DOWNLOAD_LINK_UNRESOLVED");return context.fetchDocument(action,{externalWrite:false})}
  async verifyDownloadedFile(document){return Boolean(document?.sha256&&/^[a-f0-9]{64}$/.test(document.sha256)&&Number(document.sizeBytes)>0)}
}

export class EuFundingTendersConnector extends ProtocolReplayConnector {}
export class ETendersIrelandConnector extends ProtocolReplayConnector {}

export class BoundedBrowserSession {
  static active=0;
  static maximum=Number(process.env.PORTAL_BROWSER_MAX_CONCURRENCY||1);
  constructor(driver,profile){this.driver=driver;this.profile=normalizeAdapterRecord(profile);this.context=null;this.closed=false}
  async open(){if(BoundedBrowserSession.active>=BoundedBrowserSession.maximum)throw new Error("PORTAL_BROWSER_CAPACITY_EXHAUSTED");BoundedBrowserSession.active++;try{this.context=await this.driver.newContext({javaScriptEnabled:true,acceptDownloads:true,recordVideo:undefined});return this}catch(error){BoundedBrowserSession.active--;throw error}}
  async close(){if(this.closed)return;this.closed=true;try{await this.context?.clearCookies?.();await this.context?.close?.()}finally{this.context=null;BoundedBrowserSession.active=Math.max(0,BoundedBrowserSession.active-1)}}
}

export function safeDiagnostic(value){
  const secretKeys=/password|passwort|token|cookie|authorization|credential|secret|nonce|state|csrf|session/i;
  const scrub=input=>Array.isArray(input)?input.map(scrub):input&&typeof input==="object"?Object.fromEntries(Object.entries(input).filter(([key])=>!secretKeys.test(key)).map(([key,item])=>[key,scrub(item)])):typeof input==="string"?input.replace(/(?:bearer\s+|password|passwort|token|cookie|authorization)\s*[:=]?\s*[^\s,;]+/gi,"[MASKED]").slice(0,500):input;
  return scrub(value);
}

export function adapterFor(profile){
  if(!profile?.adapter_id||profile.validation_status==="ADAPTER_REPAIR_REQUIRED"||profile.enabled!==true)throw Object.assign(new Error("UNKNOWN_PORTAL_ADAPTER_REQUIRED"),{code:"UNKNOWN_PORTAL_ADAPTER_REQUIRED"});
  if(profile.adapter_id==="eu-funding-tenders")return new EuFundingTendersConnector(profile);
  if(profile.adapter_id==="etenders-ireland")return new ETendersIrelandConnector(profile);
  return profile.login_strategy==="SOURCE_RESOLVER"?new SourceResolverConnector(profile):new GenericHttpConnector(profile);
}

export function truthfulDocumentTest({found=0,downloaded=0,verified=0,reason=null}={}){
  const counts={found:Number(found)||0,downloaded:Number(downloaded)||0,verified:Number(verified)||0};
  if(counts.verified>0)return {succeeded:true,resultCode:"DOWNLOAD_SUCCEEDED",counts};
  if(reason&&DOCUMENT_TEST_ZERO_CODES.has(reason))return {succeeded:reason==="KEINE_DOKUMENTE_VORHANDEN",resultCode:reason,counts};
  return {succeeded:false,resultCode:counts.found>0?"DOWNLOADLINK_NICHT_AUFGELOEST":"DOKUMENTENLISTE_NICHT_ERMITTELT",counts};
}
