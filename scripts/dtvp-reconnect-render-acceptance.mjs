import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const tender="411fb40f-cd2f-42e6-9d18-534c1c809261",company="15c3c602-aa51-4dd4-adc1-3586dc82e523",portal="7ea3823b-1e5c-4696-9dda-0303427544d0",lot="LOT-0001",tenderTitle="Deutschland – Gebäudereinigung – Unterhaltsreinigung Stadt Holzgerlingen";
const script=readFileSync(new URL("../platform/assets/autopilot-navigation.js",import.meta.url),"utf8");
const browser=await chromium.launch({headless:true,executablePath:"/usr/bin/chromium-browser",args:["--no-sandbox"]});
try{
  const page=await browser.newPage(),errors=[]; let verificationRequests=0;
  page.on("console",m=>{if(m.type()==="error")errors.push(m.text())});
  await page.route("**/*",async route=>{
    const url=new URL(route.request().url());
    if(url.pathname.endsWith("/autopilot-navigation.js"))return route.fulfill({status:200,contentType:"text/javascript",body:script});
    if(url.pathname.startsWith("/api/tender/")){
      const path=url.pathname.slice("/api/tender".length); let body={};
      if(path.startsWith("/autopilot/navigation/context/"))body={tender:{id:tender,title:tenderTitle,source_code:"TED",source_lifecycle_status:"ACTIVE",participation_status:"ELIGIBLE",notice_classification:"COMPETITION",offer_deadline:"2026-08-31T12:00:00.000Z"},company:{company_id:company,legal_name:"WB-Cleaning GmbH"},selected:{lotKey:lot,resultVersion:null},result:{review:{},stage_status:{}},scenarioAvailable:false,documentPortal:{Portal:"DTVP",Host:"www.dtvp.de",Status:"Portalsitzung abgelaufen"},versions:[],documents:[],requirements:[],tasks:[],calculations:[],offerDocuments:[],approvals:[],audit:[]};
      else if(path.startsWith("/portal-access/for-tender/"))body={items:[{portal_id:portal,portal_name:"DTVP",domain:"www.dtvp.de",canonical_domain:"www.dtvp.de",notice_source:"TED",configured:true,credential:{id:"masked",login_status:"LOGIN_BESTAETIGT"},access_status:"SESSION_EXPIRED",session_status:null,session_effective_status:"RELOGIN_REQUIRED_EXPIRED",authentication_target_configured:true,reconnect_available:true,reconnect_label:"Erneut anmelden",login_action:{type:"START_LOGIN",label:"Erneut anmelden",reason:"SESSION_EXPIRED",binding:{tender_id:tender,company_id:company,portal_id:portal,lot_key:lot}},affected_document_items:[],automatic_processing:false,login_required_reason:"Portalsitzung abgelaufen",missing_calculation_inputs:[],document_refresh_action:{type:"REFRESH_DOCUMENTS",label:"Dokumente aktualisieren",binding:{tender_id:tender,company_id:company,portal_id:portal,lot_key:lot}}}]};
      else if(path.includes("/portal-company-eligibility"))body={portal_name:"DTVP",company_name:"WB-Cleaning GmbH",account_holder_name:"WB-Cleaning GmbH",status_label:"Loginfähig",recommendation:"Portalsitzung erneuern"};
      else if(path.includes("/required-documents"))body={items:[],summary:{missing:0,manualReview:0,validated:0,blockers:0}};
      else if(path.includes("/bid-decision-context"))body={eligibleForDecision:false,submissionGate:{reasons:[]}};
      else if(path===`/portal-access/${portal}/login-continuations`)body={continuationId:"44444444-4444-4444-8444-444444444444",correlationToken:"fixture-token",portalAdapterId:"dtvp",credentialId:"masked",portalHost:"www.dtvp.de",verificationAction:"Anmeldung abgeschlossen – Verbindung prüfen",interactionMode:"MANAGED_CONNECTOR"};
      else if(path.includes("/portal-access/login-continuations/")){
        verificationRequests++;
        await new Promise(resolve=>setTimeout(resolve,250));
        body={status:"LOGIN_FAILED",sessionValid:false,errorId:"fixture-error-id",message:"Die gebundene Portalsitzung konnte nicht bestätigt werden."};
      }
      return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body)});
    }
    return route.fulfill({status:200,contentType:"text/html",body:`<!doctype html><html><body data-base="/admin/ausschreibungen" data-api="/api/tender"><nav id="autopilot-nav"></nav><section id="autopilot-content"></section></body></html>`});
  });
  const navigation=await page.goto(`http://127.0.0.1/admin/ausschreibungen/autopilot/detail?tender=${tender}&company=${company}&lot=${lot}`,{waitUntil:"networkidle"});
  if(!navigation||navigation.status()!==200)throw new Error(`navigation_failed:${navigation?.status()}:${page.url()}`);
  if(!(await page.locator("body").innerHTML()))throw new Error(`empty_body:${(await page.content()).slice(0,1000)}`);
  await page.addScriptTag({content:script});
  const card=page.locator(`[data-portal-card="${portal}"]`),button=card.locator(`[data-login-portal="${portal}"]`);
  try{await button.waitFor({state:"visible",timeout:10000})}catch(error){console.error(JSON.stringify({errors,body:(await page.locator("body").innerText()).slice(0,5000),html:(await page.locator("#autopilot-content").innerHTML()).slice(0,3000)}));throw error}
  const before=(await button.textContent())?.trim();
  if(before!=="Erneut anmelden")throw new Error(`wrong_label:${before}`);
  const visibleText=await page.locator("body").innerText();
  for(const expected of [tenderTitle,"WB-Cleaning GmbH","ACTIVE","DTVP","Detailunterlagen und Portalzugang"])if(!visibleText.includes(expected))throw new Error(`missing_visible_truth:${expected}`);
  const box=await button.boundingBox(); if(!box||box.width<1||box.height<1)throw new Error("button_not_clickable");
  await button.click();
  await page.waitForFunction(({portal})=>document.querySelector(`[data-login-portal="${portal}"]`)?.textContent?.includes("Anmeldung abgeschlossen"),{portal});
  const after=(await button.textContent())?.trim();
  await button.click();
  const checking=(await button.textContent())?.trim();
  if(checking!=="Verbindung wird geprüft …")throw new Error(`missing_immediate_pending_state:${checking}`);
  await page.waitForFunction(({portal})=>document.querySelector(`[data-login-portal="${portal}"]`)?.textContent?.trim()==="Erneut anmelden",{portal});
  const failureText=await card.locator(`[data-login-status="${portal}"]`).textContent();
  if(!failureText.includes("fixture-error-id")||!failureText.includes("erneut starten"))throw new Error(`missing_actionable_failure:${failureText}`);
  if(verificationRequests!==1)throw new Error(`non_idempotent_verification:${verificationRequests}`);
  console.log(JSON.stringify({passed:true,title:tenderTitle,active:true,portal:"www.dtvp.de",company:"WB-Cleaning GmbH",route:`/admin/ausschreibungen/autopilot/detail?tender=${tender}&company=${company}&lot=${lot}`,label:before,position:"Detailunterlagen und Portalzugang > DTVP > Aktionsleiste",clickable:true,afterFirstClick:after,afterSecondClick:checking,failureAction:"Erneut anmelden",errorIdVisible:true,verificationRequests,managedConnector:true,consoleErrors:errors}));
  if(errors.length)process.exitCode=1;
}finally{await browser.close()}
