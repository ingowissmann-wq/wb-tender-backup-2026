import { chromium } from "playwright";
import { domainToASCII } from "node:url";

const normalizeHost=value=>domainToASCII(String(value||"").toLowerCase().replace(/\.$/,""));
const hostsFor=portal=>new Set([portal.canonical_domain,...(portal.allowed_subdomains||[]),...(portal.authentication_domains||[]),...(portal.download_domains||[])].map(normalizeHost));
const hostAllowed=(host,allowed)=>allowed.has(normalizeHost(host));
const loginWords=/anmeld|login|sign\s*in|weiter|next|fortfahren|continue/i;
const accountWords=/abmeld|logout|mein konto|my account|profil|account|organisation|organization/i;
const mfaWords=/mfa|mehrfaktor|two.factor|2fa|authenticator|sicherheitscode|verification code|bestätigungscode|push.{0,20}bestätigen/i;
const failureWords=/falsch|ungültig|incorrect|invalid|gesperrt|locked|fehlgeschlagen|failed/i;
const consentWords=/nur notwendige|ablehnen|reject|alle akzeptieren|akzeptieren|zustimmen|accept all|allow all|einverstanden/i;

const visible=locator=>locator.first().isVisible().catch(()=>false);
async function firstVisible(locators){for(const locator of locators)if(await visible(locator))return locator.first();return null}
async function semanticInput(page,kind){
  const frames=page.frames();
  for(const frame of frames){
    const candidates=kind==="password"?[
      frame.locator('input[type="password"]'),frame.locator('input[autocomplete="current-password"]'),frame.getByLabel(/passwort|password/i)
    ]:[
      frame.locator('input[type="email"]'),frame.locator('input[autocomplete="username"]'),frame.getByLabel(/e.?mail|benutzer|user(name)?|login/i),
      frame.locator('input[name*="mail" i],input[name*="user" i],input[name*="login" i],input[placeholder*="mail" i],input[placeholder*="benutzer" i],input[placeholder*="user" i]')
    ];
    const match=await firstVisible(candidates);if(match)return match;
    if(kind==="username"&&await visible(frame.locator('input[type="password"]'))){
      const generic=frame.locator('input:not([type="hidden"]):not([type="password"]):not([type="submit"]):not([type="button"]):not([disabled])');
      const visibleGeneric=[];for(let index=0,indexMax=Math.min(await generic.count(),10);index<indexMax;index++){const item=generic.nth(index);if(await item.isVisible().catch(()=>false))visibleGeneric.push(item)}
      if(visibleGeneric.length===1)return visibleGeneric[0];
    }
  }
  return null;
}
async function clickSemantic(page,words=loginWords){for(const frame of page.frames()){const match=await firstVisible([frame.getByRole("button",{name:words}),frame.getByRole("link",{name:words}),frame.locator('button[type="submit"],input[type="submit"]')]);if(match){await Promise.allSettled([page.waitForLoadState("domcontentloaded",{timeout:15000}),match.click({timeout:10000})]);return true}}return false}
async function consent(page){for(const frame of page.frames()){const match=await firstVisible([frame.getByRole("button",{name:consentWords}),frame.getByRole("link",{name:consentWords})]);if(match){await match.click({timeout:5000}).catch(()=>{});return}}}
async function bodyText(page){return String(await page.locator("body").innerText({timeout:5000}).catch(()=>"" )).slice(0,20000)}
const sessionInvalidWords=/session.{0,25}(abgelaufen|expired)|sitzung.{0,25}abgelaufen|erneut.{0,20}anmeld/i;
const authenticatedWords=/abmeld|logout|mein konto|profil|organisation|vergabeverfahren|vergabeunterlagen|bieterbereich|workflowopen|wf_evalink/i;
const safeBrowserFailure=(error,phase)=>({
  resultCode:error?.name==="TimeoutError"?"PORTAL_NICHT_ERREICHBAR":"TECHNISCHER_CONNECTORFEHLER",
  failurePhase:phase,
  failureClass:String(error?.name||"Error").slice(0,80),
  failureReason:String(error?.message||"browser operation failed").replace(/https?:\/\/[^\s]+/gi,"[portal-url]").slice(0,240)
});
export async function browserSessionState(context,page){
  const storageState=await context.storageState(),sessionStorage=[];
  for(const candidate of context.pages()){
    const origin=await candidate.evaluate(()=>location.origin).catch(()=>null);
    if(!origin||origin==="null"||sessionStorage.some(item=>item.origin===origin))continue;
    const entries=await candidate.evaluate(()=>Object.entries(window.sessionStorage)).catch(()=>[]);
    sessionStorage.push({origin,entries});
  }
  const cookies=storageState.cookies||[];
  return {cookies,cookie:cookieHeaderForUrl(cookies,page.url()),storageState,sessionStorage,formatVersion:2};
}
async function contextFromSession(browser,session){
  const options={acceptDownloads:true,javaScriptEnabled:true,locale:"de-DE"};
  if(session?.storageState)options.storageState=session.storageState;
  const context=await browser.newContext(options);
  if(!session?.storageState&&session?.cookies?.length)await context.addCookies(session.cookies);
  if(Array.isArray(session?.sessionStorage)&&session.sessionStorage.length)await context.addInitScript(states=>{
    const state=states.find(item=>item.origin===location.origin);
    if(state)for(const [key,value] of state.entries||[])window.sessionStorage.setItem(key,value);
  },session.sessionStorage);
  return context;
}
async function authenticatedPortalState(page,allowed,targetUrl,timeoutMs){
  await page.goto(targetUrl,{waitUntil:"domcontentloaded",timeout:timeoutMs});await consent(page);
  const current=new URL(page.url()),text=await bodyText(page),password=await semanticInput(page,"password");
  const valid=hostAllowed(current.hostname,allowed)&&!password&&!sessionInvalidWords.test(text)&&authenticatedWords.test(`${text}\n${await page.content().catch(()=>"")}`);
  return {valid,url:page.url(),loginVisible:Boolean(password),sessionExpired:sessionInvalidWords.test(text)};
}
export async function restorePortalSessionWithBrowser({portal,session,targetUrl,timeoutMs=120000,headless=true}={}){
  const allowed=hostsFor(portal);let phase="BROWSER_START";
  if(!targetUrl||!hostAllowed(new URL(targetUrl).hostname,allowed))return {resultCode:"LOGIN_REDIRECT_UNERWARTET",failurePhase:"TARGET_VALIDATION"};
  const browser=await chromium.launch({headless,executablePath:process.env.CHROMIUM_EXECUTABLE_PATH||"/usr/bin/chromium-browser",args:["--disable-dev-shm-usage","--no-sandbox"]});
  let context;
  try{
    phase="STORAGE_STATE_IMPORT";context=await contextFromSession(browser,session);
    const page=await context.newPage();phase="AUTHENTICATED_AREA_VERIFICATION";
    const verification=await authenticatedPortalState(page,allowed,targetUrl,timeoutMs);
    if(!verification.valid)return {resultCode:"SESSION_RESTORE_FAILED",verification};
    phase="STORAGE_STATE_EXPORT";const restored=await browserSessionState(context,page);
    return {resultCode:"SESSION_VALID",session:restored,sessionExpiresAt:new Date(Date.now()+3600000).toISOString(),authenticatedUrl:verification.url,verification};
  }catch(error){return {...safeBrowserFailure(error,phase),resultCode:"SESSION_RESTORE_FAILED"}}finally{await context?.close().catch(()=>{});await browser.close().catch(()=>{})}
}
export function cookieHeaderForUrl(cookies,url){const target=new URL(url),path=target.pathname||"/",now=Date.now()/1000;return (cookies||[]).filter(cookie=>{
  const domain=normalizeHost(String(cookie.domain||"").replace(/^\./,"")),cookiePath=String(cookie.path||"/")||"/",domainOk=normalizeHost(target.hostname)===domain||normalizeHost(target.hostname).endsWith(`.${domain}`),pathOk=path===cookiePath||path.startsWith(cookiePath.endsWith("/")?cookiePath:`${cookiePath}/`),secureOk=!cookie.secure||target.protocol==="https:",fresh=!cookie.expires||cookie.expires<0||cookie.expires>now;return domainOk&&pathOk&&secureOk&&fresh
}).map(cookie=>`${cookie.name}=${cookie.value}`).join("; ")}

export function classifyDeutscheEvergabeWorkflow(html=""){
  const source=String(html);
  if(/href=["'][^"']*WorkflowOpen[^"']*A=WF_VUDownload[^"']*["']/i.test(source))return "WF_VU_DOWNLOAD";
  if(/href=["'][^"']*WorkflowOpen[^"']*A=WF_EVALINK[^"']*["']/i.test(source))return "WF_EVA_LINK";
  return "UNKNOWN";
}

export async function authenticatePortalWithBrowser({portal,credential,targetUrl=null,timeoutMs=120000,headless=true}={}){
  const allowed=hostsFor(portal),configuredEntry=new URL(portal.authentication_entry_url||portal.login_path||"/",`https://${portal.canonical_domain}`).href,entry=new URL(configuredEntry).pathname==="/"&&targetUrl?targetUrl:configuredEntry;
  if(!hostAllowed(new URL(entry).hostname,allowed))return {resultCode:"LOGIN_REDIRECT_UNERWARTET"};
  const browser=await chromium.launch({headless,executablePath:process.env.CHROMIUM_EXECUTABLE_PATH||"/usr/bin/chromium-browser",args:["--disable-dev-shm-usage","--no-sandbox"]});
  const context=await browser.newContext({acceptDownloads:true,javaScriptEnabled:true,locale:"de-DE"}),page=await context.newPage();
  let forbidden=false,phase="INITIAL_NAVIGATION";
  page.on("framenavigated",frame=>{if(frame===page.mainFrame()){try{const url=new URL(frame.url());if(url.protocol!=="about:"&&!hostAllowed(url.hostname,allowed))forbidden=true}catch{}}});
  try{
    await page.goto(entry,{waitUntil:"domcontentloaded",timeout:timeoutMs});await consent(page);if(forbidden)return {resultCode:"LOGIN_REDIRECT_UNERWARTET"};phase="LOGIN_FORM_DISCOVERY";
    let username,password,portalSubmit=null;
    if(portal.adapter_id==="dtvp"){
      password=page.locator('input[type="password"]').first();
      if(!await visible(password)){password=null;username=null}else{const form=password.locator("xpath=ancestor::form[1]");username=form.locator('input:not([type="submit"]):not([type="image"]):not([type="hidden"])[autocomplete="username"],input[type="email"],input:not([type="submit"]):not([type="image"]):not([type="hidden"])[name*="user" i],input:not([type="submit"]):not([type="image"]):not([type="hidden"])[name*="email" i],input:not([type="submit"]):not([type="image"]):not([type="hidden"])[name*="login" i],input[type="text"]').last();if(!await visible(username))username=null;portalSubmit=form.locator('button[type="submit"],input[type="submit"],input[type="image"],button:not([type])').first();if(!await visible(portalSubmit))portalSubmit=null}
    }else{username=await semanticInput(page,"username");password=await semanticInput(page,"password")}
    if(!username&&!password){if(await clickSemantic(page)){await page.waitForTimeout(900);await consent(page);username=await semanticInput(page,"username");password=await semanticInput(page,"password")}}
    if(!username&&!password){const pageText=await bodyText(page),cookies=await context.cookies(),cookie=cookieHeaderForUrl(cookies,targetUrl||entry);if(accountWords.test(pageText)&&cookie){const session=await browserSessionState(context,page);return {resultCode:"LOGIN_ERFOLGREICH",session,sessionExpiresAt:new Date(Date.now()+3600000).toISOString(),documentAccess:true,authenticatedUrl:page.url(),verifiedAt:new Date().toISOString()}}return {resultCode:"LOGIN_FORMULAR_GEAENDERT"}}
    if(!username&&password===null)return {resultCode:"LOGIN_FORMULAR_GEAENDERT"};
    if(username){await username.fill(String(credential.username||""));password=await semanticInput(page,"password");if(!password){await clickSemantic(page);await page.waitForTimeout(750);await consent(page);password=await semanticInput(page,"password")}}
    if(!password)return {resultCode:"LOGIN_FORMULAR_GEAENDERT"};
    phase="CREDENTIAL_SUBMISSION";await password.fill(String(credential.password||""));if(portalSubmit)await Promise.all([page.waitForNavigation({waitUntil:"domcontentloaded",timeout:30000}).catch(()=>null),portalSubmit.click({timeout:10000,noWaitAfter:true}).catch(error=>{if(error?.name!=="TimeoutError")throw error})]);else await clickSemantic(page);await page.waitForTimeout(1200);await consent(page);if(forbidden)return {resultCode:"LOGIN_REDIRECT_UNERWARTET"};
    const text=await bodyText(page),otp=await firstVisible(page.frames().flatMap(frame=>[frame.locator('input[autocomplete="one-time-code"]'),frame.getByLabel(/code|tan|otp|authenticator/i)]));
    if(otp||mfaWords.test(text))return {resultCode:"MFA_BESTÄTIGUNG_ERFORDERLICH",mfaUrl:page.url()};
    if(failureWords.test(text)&&await semanticInput(page,"password"))return {resultCode:"BENUTZERNAME_ODER_PASSWORT_FALSCH"};
    const loginStill=Boolean(await semanticInput(page,"password")),accountVisible=accountWords.test(text);
    if(loginStill&&!accountVisible)return {resultCode:"BENUTZERNAME_ODER_PASSWORT_FALSCH"};
    if(targetUrl&&hostAllowed(new URL(targetUrl).hostname,allowed)){phase="AUTHENTICATED_AREA_VERIFICATION";const verification=await authenticatedPortalState(page,allowed,targetUrl,timeoutMs);if(!verification.valid)return {resultCode:"SESSION_COOKIE_FEHLT",verification}}
    phase="STORAGE_STATE_EXPORT";const session=await browserSessionState(context,page);
    if(!session.cookies.length||!session.cookie)return {resultCode:"SESSION_COOKIE_FEHLT"};
    return {resultCode:"LOGIN_ERFOLGREICH",session,sessionExpiresAt:new Date(Date.now()+3600000).toISOString(),documentAccess:true,authenticatedUrl:page.url(),verifiedAt:new Date().toISOString()};
  }catch(error){return safeBrowserFailure(error,phase)}finally{await context.close().catch(()=>{});await browser.close().catch(()=>{})}
}

export async function downloadAuthenticatedDeutscheEvergabeEvaArchive({portal,credential,session=null,tenderGuid,timeoutMs=120000,maxBytes=250_000_000}={}){
  if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(tenderGuid||"")))throw new Error("deutsche_evergabe_tender_guid_invalid");
  const workflowUrl=`https://portal.deutsche-evergabe.de/WORKFLOW/WORKFLOW/${tenderGuid}`;
  const auth=session?{resultCode:"LOGIN_ERFOLGREICH",session}:await authenticatePortalWithBrowser({portal,credential,targetUrl:workflowUrl,timeoutMs});
  if(auth.resultCode!=="LOGIN_ERFOLGREICH")throw Object.assign(new Error("deutsche_evergabe_authentication_failed"),{code:auth.resultCode});
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE_PATH||"/usr/bin/chromium-browser",args:["--disable-dev-shm-usage","--no-sandbox"]});
  const context=await contextFromSession(browser,auth.session),page=await context.newPage();
  try{
    await page.goto(workflowUrl,{waitUntil:"domcontentloaded",timeout:timeoutMs});
    if(new URL(page.url()).hostname!=="portal.deutsche-evergabe.de")throw new Error("deutsche_evergabe_workflow_redirect_invalid");
    const eva=page.locator('a[href*="WorkflowOpen"][href*="A=WF_EVALINK"]').first();
    if(!await eva.isVisible().catch(()=>false))throw new Error("deutsche_evergabe_eva_link_missing");
    const evaHref=await eva.getAttribute("href");if(!evaHref)throw new Error("deutsche_evergabe_eva_link_missing");
    await page.goto(new URL(evaHref,workflowUrl).href,{waitUntil:"domcontentloaded",timeout:timeoutMs});
    const continuation=page.locator(`a[href*="weiterleitungEVA/${tenderGuid}"]`).first();
    if(!await continuation.isVisible().catch(()=>false))throw new Error("deutsche_evergabe_eva_continuation_missing");
    const continuationHref=await continuation.getAttribute("href");if(!continuationHref)throw new Error("deutsche_evergabe_eva_continuation_missing");
    await page.goto(new URL(continuationHref,page.url()).href,{waitUntil:"domcontentloaded",timeout:timeoutMs});
    const finalUrl=new URL(page.url());
    if(finalUrl.hostname!=="www.evergabe.bayern.de"||!/\/evergabe\.bieter\/ProjectDetails\.aspx$/i.test(finalUrl.pathname))throw new Error("deutsche_evergabe_eva_project_details_missing");
    const documents=await firstVisible([
      page.getByRole("link",{name:/Vergabeunterlagen/i}),page.getByRole("button",{name:/Vergabeunterlagen/i}),
      page.locator('a[href*="Vergabeunterlagen" i],button[data-action*="Vergabeunterlagen" i],input[value*="Vergabeunterlagen" i]'),
      page.getByText(/Vergabeunterlagen/i)
    ]);
    if(!documents)throw new Error("deutsche_evergabe_eva_documents_control_missing");
    await documents.click({timeout:15_000});
    const confirm=page.getByText("Ja",{exact:true}).first();
    await confirm.waitFor({state:"visible",timeout:15_000}).catch(()=>{});
    if(!await confirm.isVisible().catch(()=>false))throw new Error("deutsche_evergabe_eva_download_confirmation_missing");
    // EVA can couple this confirmation to document-access registration and
    // message subscription. A read-only worker must never accept such a dialog,
    // even if it could try to undo the resulting portal-side state afterwards.
    throw Object.assign(new Error("deutsche_evergabe_document_access_registration_required"),{code:"DOCUMENT_ACCESS_REGISTRATION_REQUIRED"});
  }finally{await context.close().catch(()=>{});await browser.close().catch(()=>{})}
}

export async function downloadPublicEvergabeOnlineArchive(targetUrl,{timeoutMs=60_000,maxBytes=250_000_000}={}){
  const target=new URL(targetUrl);
  if(target.protocol!=="https:"||target.hostname!=="www.evergabe-online.de"||target.pathname!=="/tenderdocuments.html"||!/^\d+$/.test(target.searchParams.get("id")||""))throw new Error("evergabe_online_target_forbidden");
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE_PATH||"/usr/bin/chromium-browser",args:["--disable-dev-shm-usage","--no-sandbox"]}),context=await browser.newContext({acceptDownloads:true,javaScriptEnabled:true,locale:"de-DE"}),page=await context.newPage();
  try{
    await page.goto(target.href,{waitUntil:"domcontentloaded",timeout:timeoutMs});
    if(new URL(page.url()).hostname!==target.hostname)throw new Error("evergabe_online_redirect_forbidden");
    const control=page.getByRole("link",{name:/Als ZIP-Datei herunterladen/i}).first();
    if(!await control.isVisible().catch(()=>false))throw new Error("evergabe_online_archive_control_missing");
    const [download]=await Promise.all([page.waitForEvent("download",{timeout:timeoutMs}),control.click({timeout:15_000})]);
    const failure=await download.failure();if(failure)throw new Error("evergabe_online_download_failed");
    const stream=await download.createReadStream(),chunks=[];let bytes=0;
    for await(const chunk of stream){bytes+=chunk.length;if(bytes>maxBytes)throw new Error("document_size_invalid");chunks.push(Buffer.from(chunk))}
    const buffer=Buffer.concat(chunks),name=String(download.suggestedFilename()||"Vergabeunterlagen.zip").replace(/[^\p{L}\p{N}._ -]/gu,"_").slice(0,240);
    if(buffer[0]!==0x50||buffer[1]!==0x4b)throw new Error("evergabe_online_archive_signature_invalid");
    return {status:"FETCHED",httpStatus:200,url:target.href,mime:"application/zip",disposition:`attachment; filename="${name}"`,buffer,browserBound:true,authenticated:false,externalWrite:false};
  }finally{await context.close().catch(()=>{});await browser.close().catch(()=>{})}
}

export async function downloadPublicDuesseldorfNetServerArchive(targetUrl,{timeoutMs=60_000,maxBytes=250_000_000}={}){
  const target=new URL(targetUrl);
  if(target.protocol!=="https:"||target.hostname!=="vergabe.duesseldorf.de"||target.pathname!=="/NetServer/TenderingProcedureDetails"||target.searchParams.get("function")!=="_Details"||!/^54321-Tender-[a-z0-9-]+$/i.test(target.searchParams.get("TenderOID")||""))throw new Error("duesseldorf_netserver_target_forbidden");
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE_PATH||"/usr/bin/chromium-browser",args:["--disable-dev-shm-usage","--no-sandbox"]}),context=await browser.newContext({acceptDownloads:true,javaScriptEnabled:true,locale:"de-DE"}),page=await context.newPage();
  try{
    await page.goto(target.href,{waitUntil:"domcontentloaded",timeout:timeoutMs});
    if(new URL(page.url()).hostname!==target.hostname)throw new Error("duesseldorf_netserver_redirect_forbidden");
    const versions=page.locator("a.zipFileContents[data-oid][data-token]");
    if(!await versions.count())throw new Error("duesseldorf_netserver_archive_control_missing");
    await versions.first().click({timeout:15_000});
    const form=page.locator("form#downloadSelection"),selectAll=form.locator("input[type=button]").first(),submit=form.locator("input[type=submit]").first();
    await form.waitFor({state:"visible",timeout:15_000});
    if(!await selectAll.isVisible().catch(()=>false)||!await submit.isVisible().catch(()=>false))throw new Error("duesseldorf_netserver_archive_form_missing");
    await selectAll.click({timeout:10_000});
    const [download]=await Promise.all([page.waitForEvent("download",{timeout:timeoutMs}),submit.click({timeout:15_000})]);
    const failure=await download.failure();if(failure)throw new Error("duesseldorf_netserver_download_failed");
    const stream=await download.createReadStream(),chunks=[];let bytes=0;
    for await(const chunk of stream){bytes+=chunk.length;if(bytes>maxBytes)throw new Error("document_size_invalid");chunks.push(Buffer.from(chunk))}
    const buffer=Buffer.concat(chunks),name=String(download.suggestedFilename()||"Vergabeunterlagen.zip").replace(/[^\p{L}\p{N}._ -]/gu,"_").slice(0,240);
    if(buffer[0]!==0x50||buffer[1]!==0x4b)throw new Error("duesseldorf_netserver_archive_signature_invalid");
    return {status:"FETCHED",httpStatus:200,url:target.href,mime:"application/zip",disposition:`attachment; filename="${name}"`,buffer,browserBound:true,authenticated:false,externalWrite:false};
  }finally{await context.close().catch(()=>{});await browser.close().catch(()=>{})}
}
