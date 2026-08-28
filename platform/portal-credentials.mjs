import crypto from "node:crypto";
import {readFileSync} from "node:fs";
import {lookup} from "node:dns/promises";
import {
  credentialAccountEligibility,
  credentialJobEligibility,
  portalCatalogProfile,
  tenderPortalEligibility as capabilityTenderPortalEligibility,
} from "./portal-capability-policy.mjs";

export {credentialAccountEligibility,credentialJobEligibility,portalCatalogProfile};

const RESULTS=new Set(["LOGIN_ERFOLGREICH","BENUTZERNAME_ODER_PASSWORT_FALSCH","KONTO_GESPERRT","PASSWORT_ABGELAUFEN","MFA_BESTÄTIGUNG_ERFORDERLICH","CAPTCHA_MANUELL_ERFORDERLICH","CSRF_TOKEN_FEHLT","SESSION_COOKIE_FEHLT","LOGIN_FORMULAR_GEAENDERT","JAVASCRIPT_BROWSERKONTEXT_ERFORDERLICH","LOGIN_REDIRECT_UNERWARTET","SSO_WEITERLEITUNG_ERFORDERLICH","CONSENT_INTERAKTION_ERFORDERLICH","PORTAL_NICHT_ERREICHBAR","DOKUMENTENBERECHTIGUNG_FEHLT","TECHNISCHER_CONNECTORFEHLER"]);
const forbiddenHost=host=>/^(localhost|0\.0\.0\.0|127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i.test(host);
const forbiddenAddress=address=>forbiddenHost(address)||/^f[cd][0-9a-f]{2}:|^fe80:|^::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(address);
async function assertPublicDns(host){const addresses=await lookup(host,{all:true,verbatim:true});if(!addresses.length||addresses.some(item=>forbiddenAddress(item.address)))throw new Error("portal_dns_target_forbidden")}
export function credentialKey(path=process.env.PORTAL_CREDENTIAL_KEY_FILE){if(!path)throw new Error("portal_credential_key_missing");const raw=readFileSync(path,"utf8").trim(),key=Buffer.from(raw,"base64");if(key.length!==32)throw new Error("portal_credential_key_invalid");return key}
export function encryptSecret(payload,key=credentialKey()){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",key,iv);cipher.setAAD(Buffer.from("WB_TENDER_PORTAL_CREDENTIAL_V1"));const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload),"utf8"),cipher.final()]);return {ciphertext,iv,authTag:cipher.getAuthTag(),keyVersion:1}}
export function decryptSecret(record,key=credentialKey()){const decipher=crypto.createDecipheriv("aes-256-gcm",key,record.iv);decipher.setAAD(Buffer.from("WB_TENDER_PORTAL_CREDENTIAL_V1"));decipher.setAuthTag(record.auth_tag||record.authTag);return JSON.parse(Buffer.concat([decipher.update(record.ciphertext),decipher.final()]).toString("utf8"))}
export function maskUsername(value){const text=String(value||"").trim();if(!text)return null;const at=text.indexOf("@");if(at>0)return `${text[0]}***@${text.slice(at+1)}`;return `${text.slice(0,Math.min(2,text.length))}***`}
const metadataStatusToken=value=>String(value??"").trim().toUpperCase().replace(/Ä/g,"AE").replace(/Ö/g,"OE").replace(/Ü/g,"UE").replace(/ẞ/g,"SS").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^A-Z0-9]+/g,"_").replace(/^_+|_+$/g,"");
const portalMetadataStatuses={
  registrationStatus:new Map([["NICHT_REGISTRIERT","NICHT_REGISTRIERT"],["REGISTRIERUNG_OFFEN","REGISTRIERUNG_OFFEN"],["REGISTRIERT","REGISTRIERT"],["MANUELLE_PRUEFUNG","MANUELLE_PRUEFUNG"]]),
  loginStatus:new Map([["LOGIN_UNGEPRUEFT","LOGIN_UNGEPRUEFT"],["UNGEPRUEFT","LOGIN_UNGEPRUEFT"],["LOGIN_BESTAETIGT","LOGIN_BESTAETIGT"],["BESTAETIGT","LOGIN_BESTAETIGT"],["MFA_ERFORDERLICH","MFA_ERFORDERLICH"],["ZUGANG_GESPERRT","ZUGANG_GESPERRT"],["ZUGANG_ABGELAUFEN","ZUGANG_ABGELAUFEN"],["MANUELLE_PRUEFUNG","MANUELLE_PRUEFUNG"]]),
};
export function canonicalPortalMetadataStatus(field,value){return portalMetadataStatuses[field]?.get(metadataStatusToken(value))||null}
export function credentialStateFingerprint({credentialId,version,portalId,companyId,savedAt}){return crypto.createHash("sha256").update(["WB_PORTAL_CREDENTIAL_STATE_V1",credentialId,version,portalId,companyId,new Date(savedAt).toISOString()].join(":"),"utf8").digest("hex")}
export function portalCredentialJobKey({actionType,portalId,companyId,credentialId,credentialVersion}){return [String(actionType),String(portalId),String(companyId),String(credentialId),`CREDV${Number(credentialVersion)}`].join(":")}
export function isTechnicalPublicationSource(portal={}){
  const host=String(portal.canonical_domain||portal.domain||"").trim().toLowerCase().replace(/\.$/,""),
    name=String(portal.display_name||portal.portalName||"").trim().toLowerCase(),
    adapter=String(portal.adapter_id||portal.adapterId||"").trim().toLowerCase();
  return host==="oeffentlichevergabe.de"||host.endsWith(".oeffentlichevergabe.de")||
    /\bocds\b|\bdoe(?:-|\b)|technical[-_ ]?(?:source|payload)/i.test(`${name} ${adapter}`);
}
export function credentialPortalEligibility(portal={}){
  if(isTechnicalPublicationSource(portal))return {eligible:false,code:"PORTAL_DER_AUSSCHREIBUNG_NICHT_ERMITTELT"};
  if(!String(portal.canonical_domain||portal.domain||"").trim())return {eligible:false,code:"PORTAL_NICHT_VALIDIERT"};
  const profile=portalCatalogProfile(portal);
  if(profile.isTedService)return profile.knownTedService&&profile.accountTypes.length
    ?{eligible:true,code:null}
    :{eligible:false,code:profile.knownTedService?"CREDENTIAL_ACCOUNT_TYPE_NOT_SUPPORTED":"PORTAL_NICHT_VALIDIERT"};
  if(!portal.adapter_id||portal.adapter_enabled!==true)return {eligible:false,code:"KEIN_ADAPTER_VERFUEGBAR"};
  const validation=String(portal.adapter_validation_status||portal.adapterValidationStatus||"").toUpperCase();
  if(validation==="LOGIN_REQUIRED"){
    const verifiedAuthenticationTarget=Boolean(portal.authentication_entry_url)&&Boolean(portal.last_verified_at||portal.entry_links_verified_at);
    return verifiedAuthenticationTarget
      ?{eligible:true,code:null,loginValidationPending:true}
      :{eligible:false,code:"PORTAL_NICHT_VALIDIERT"};
  }
  if(validation!=="PRODUCTION_VALIDATED")return {eligible:false,code:"PORTAL_NICHT_VALIDIERT"};
  return {eligible:true,code:null};
}
export function tenderCredentialPortalEligibility(portal={}){
  if(isTechnicalPublicationSource(portal))return {eligible:false,code:"PORTAL_DER_AUSSCHREIBUNG_NICHT_ERMITTELT"};
  const capabilityDecision=capabilityTenderPortalEligibility(portal);
  if(capabilityDecision)return capabilityDecision;
  return credentialPortalEligibility(portal);
}
export function canonicalPortalUrl(value,domain,allowed=[]){let url;try{url=new URL(value)}catch{throw new Error("portal_url_invalid")}const host=url.hostname.toLowerCase(),valid=host===domain||allowed.map(x=>x.toLowerCase()).includes(host);if(url.protocol!=="https:"||!valid||forbiddenHost(host)||url.username||url.password)throw new Error("portal_domain_binding_failed");url.hash="";return url}
export function publicCredential(record,{manage=false}={}){return {configured:Boolean(record),usernameMasked:manage?record?.username_masked||null:undefined,internalLabel:manage?record?.internal_label||null:undefined,contactPerson:manage?record?.contact_person||null:undefined,notes:manage?record?.notes||null:undefined,mfaMethod:record?.mfa_method||null,mfaRequired:record?.mfa_required_state??null,registrationStatus:record?.registration_status||null,loginStatus:record?.login_status||null,lastManualCheckAt:record?.last_manual_check_at||null,validUntil:record?.valid_until||null,createdAt:record?.created_at||null,accountConfirmed:record?.account_confirmed===true,readOnly:record?!record.submission_capable:null,status:record?.status||null,accountType:record?.account_type||null,authorizedCapabilities:Array.isArray(record?.authorized_capabilities)?record.authorized_capabilities:[],boundHost:record?.bound_host||null}}
export const portalAccessCapabilities=identity=>({manage:identity.permissions.includes("tender.admin")||identity.permissions.includes("tender.portal.manage"),view:identity.permissions.some(code=>["tender.admin","tender.portal.manage","tender.view_assigned","tender.view","tender.read"].includes(code))});
const bodyText=async response=>String(await response.text()).slice(0,1_000_000);
const decodeHtml=value=>String(value||"").replaceAll("&amp;","&").replaceAll("&quot;",'"').replaceAll("&#39;", "'").replaceAll("&lt;","<").replaceAll("&gt;",">");
const captchaEvidence=text=>/<(?:iframe|div|textarea|input)[^>]+(?:class|id|name|src)=["'][^"']*(?:g-recaptcha|h-captcha|cf-turnstile|captcha-response|captcha-input)[^"']*["']/i.test(text)||/<input[^>]+(?:name|id)=["'][^"']*captcha[^"']*["'][^>]*>/i.test(text)||/(?:captcha|bot)[ _-]?challenge[^<]{0,80}(?:manuell|eingeben|lösen|required)/i.test(text);
const classify=(response,text,{loginPage=false}={})=>{if(loginPage&&captchaEvidence(text))return "CAPTCHA_MANUELL_ERFORDERLICH";const mfaChallenge=/<(?:input|form)[^>]+(?:name|id|action)=["'][^"']*(?:otp|one.?time|mfa|two.?factor|authenticator)[^"']*["']/i.test(text)||/(?:einmalcode|bestätigungscode|verification code|authenticator code|\botp\b).{0,80}(?:eingeben|enter|required|erforderlich)/i.test(text);if(mfaChallenge)return "MFA_BESTÄTIGUNG_ERFORDERLICH";if(/konto.{0,30}gesperrt|account.{0,30}locked/i.test(text))return "KONTO_GESPERRT";if(/passwort.{0,30}abgelaufen|password.{0,30}expired/i.test(text))return "PASSWORT_ABGELAUFEN";if(/ungültig.{0,40}(benutzer|passwort|anmeld)|invalid.{0,40}(username|password|credential)/i.test(text))return "BENUTZERNAME_ODER_PASSWORT_FALSCH";if(response.status===401)return "BENUTZERNAME_ODER_PASSWORT_FALSCH";return null};
const formInfo=(text,base)=>{const passwordName=text.match(/\bname=["']([^"']*(?:password|passwort|kennwort)[^"']*)["']/i)?.[1];if(!passwordName)return null;const tag=text.match(/<form\b[^>]*\bid=["']kc-form-login["'][^>]*>|<form\b[^>]*>/i)?.[0];if(!tag)return null;const action=decodeHtml(tag.match(/\baction=["']([^"']+)["']/i)?.[1]||base.href),method=(tag.match(/\bmethod=["']([^"']+)["']/i)?.[1]||"post").toUpperCase(),fields={};for(const input of text.matchAll(/<input\b[^>]*>/gi)){const name=input[0].match(/\bname=["']([^"']+)["']/i)?.[1];if(name)fields[name]=decodeHtml(input[0].match(/\bvalue=["']([^"']*)["']/i)?.[1]||"")}const usernameName=text.match(/\bname=["']([^"']*(?:username|user.?name|email|benutzername)[^"']*)["']/i)?.[1]||null;return {action:new URL(action,base),method,fields,usernameName,passwordName,hasUsername:Boolean(usernameName),hasPassword:true}};
const cookieHeader=(jar,url)=>[...jar.values()].filter(x=>url.hostname===x.domain||(!x.hostOnly&&url.hostname.endsWith(`.${x.domain}`))).map(x=>`${x.name}=${x.value}`).join("; ");
const absorbCookies=(response,jar,url)=>{const values=response.headers.getSetCookie?.()||[response.headers.get("set-cookie")].filter(Boolean);for(const raw of values){const parts=raw.split(";").map(x=>x.trim()),at=parts[0].indexOf("=");if(at<1)continue;const name=parts[0].slice(0,at),value=parts[0].slice(at+1),domain=(parts.find(x=>/^domain=/i.test(x))?.split("=").slice(1).join("=")||url.hostname).replace(/^\./,"").toLowerCase(),hostOnly=!parts.some(x=>/^domain=/i.test(x)),key=`${domain}\u0000${name}`;if(value&& !parts.some(x=>/^max-age=0$/i.test(x)))jar.set(key,{name,value,domain,hostOnly});else jar.delete(key)}};
async function boundedFetch(fetchImpl,url,options,portal,jar=new Map()){
  let current=url;const allowed=[...(portal.allowed_subdomains||[]),...(portal.authentication_domains||[]),...(portal.download_domains||[])],maximum=Math.min(12,Math.max(1,Number(portal.max_redirects||8)));
  for(let redirect=0;redirect<maximum;redirect++){
    if(fetchImpl===fetch)await assertPublicDns(current.hostname);
    const headers={...(options.headers||{})},cookies=cookieHeader(jar,current);if(cookies)headers.cookie=cookies;
    const response=await fetchImpl(current,{...options,headers,redirect:"manual",signal:AbortSignal.timeout(Number(portal.timeout_profile?.navigationMs||15_000))});absorbCookies(response,jar,current);
    if(response.status>=300&&response.status<400&&response.headers.get("location")){
      if(redirect===maximum-1)throw new Error("login_redirect_unexpected");
      try{current=canonicalPortalUrl(new URL(response.headers.get("location"),current).href,portal.canonical_domain,allowed)}catch{throw new Error("login_redirect_unexpected")}
      continue;
    }
    return {response,url:current};
  }
  throw new Error("login_redirect_unexpected");
}
export async function testReadOnlyPortal({portal,credential,fetchImpl=fetch,documentTest=false,oneTimeCode=null}){try{const jar=new Map(),login=canonicalPortalUrl(new URL(portal.login_path||"/",`https://${portal.canonical_domain}`).href,portal.canonical_domain,portal.allowed_subdomains),landed=await boundedFetch(fetchImpl,login,{method:"GET",headers:{"user-agent":"WB-Tender-ReadOnly-Connector/2.0"}},portal,jar),landing=landed.response,landingText=await bodyText(landing),loginForm=formInfo(landingText,landed.url),pre=classify(landing,landingText,{loginPage:Boolean(loginForm)});if(pre)return {resultCode:pre};let auth=landing,authText=landingText,authUrl=landed.url;if(!credential?.anonymous){if(!loginForm||!loginForm.hasUsername||!loginForm.hasPassword)return {resultCode:"LOGIN_FORMULAR_GEAENDERT"};const form=new URLSearchParams(loginForm.fields||{});form.set(loginForm.usernameName,credential.username);form.set(loginForm.passwordName,credential.password);if(oneTimeCode)form.set("otp",oneTimeCode);const submitted=await boundedFetch(fetchImpl,loginForm.action,{method:loginForm.method||"POST",headers:{"content-type":"application/x-www-form-urlencoded","user-agent":"WB-Tender-ReadOnly-Connector/2.0","origin":`${loginForm.action.protocol}//${loginForm.action.host}`},body:form},portal,jar);auth=submitted.response;authUrl=submitted.url;authText=await bodyText(auth)}const returnedForm=formInfo(authText,authUrl),classified=classify(auth,authText,{loginPage:Boolean(returnedForm)});if(classified)return {resultCode:classified};if(returnedForm&&!credential?.anonymous)return {resultCode:"BENUTZERNAME_ODER_PASSWORT_FALSCH"};if(auth.status===401)return {resultCode:"LOGIN_ERFORDERLICH"};if(auth.status===403)return {resultCode:"DOKUMENTENBERECHTIGUNG_FEHLT"};if(!auth.ok)return {resultCode:"TECHNISCHER_CONNECTORFEHLER"};if(!credential?.anonymous&&!jar.size)return {resultCode:"SESSION_COOKIE_FEHLT"};const documentUrl=canonicalPortalUrl(new URL(portal.document_path||"/",`https://${portal.canonical_domain}`).href,portal.canonical_domain,portal.allowed_subdomains),loaded=await boundedFetch(fetchImpl,documentUrl,{method:"GET",headers:{"user-agent":"WB-Tender-ReadOnly-Connector/2.0"}},portal,jar),documents=loaded.response,documentsText=await bodyText(documents);if(documents.status===401)return {resultCode:"SESSION_COOKIE_FEHLT"};if(documents.status===403)return {resultCode:"DOKUMENTENBERECHTIGUNG_FEHLT"};const documentClass=classify(documents,documentsText,{loginPage:Boolean(formInfo(documentsText,loaded.url))});if(documentClass)return {resultCode:documentClass};if(formInfo(documentsText,loaded.url)&&!credential?.anonymous)return {resultCode:"SESSION_COOKIE_FEHLT"};if(!documents.ok)return {resultCode:"TECHNISCHER_CONNECTORFEHLER"};return {resultCode:"LOGIN_ERFOLGREICH",session:jar.size?{cookie:cookieHeader(jar,new URL(authUrl))}:null,sessionExpiresAt:new Date(Date.now()+3600000).toISOString(),documentAccess:true,documentTest}}catch(error){const message=String(error?.message||""),code=String(error?.cause?.code||error?.code||"");if(message==="login_redirect_unexpected"||message==="portal_domain_binding_failed")return {resultCode:"LOGIN_REDIRECT_UNERWARTET"};if(error?.name==="TimeoutError"||/^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|CERT_|ERR_TLS)/.test(code))return {resultCode:"PORTAL_NICHT_ERREICHBAR"};return {resultCode:"TECHNISCHER_CONNECTORFEHLER"}}
}
export function assertResult(value){if(!RESULTS.has(value))throw new Error("portal_result_invalid");return value}
export function containsSecret(value,secrets=[]){const text=JSON.stringify(value);return secrets.filter(Boolean).some(secret=>text.includes(String(secret)))}
