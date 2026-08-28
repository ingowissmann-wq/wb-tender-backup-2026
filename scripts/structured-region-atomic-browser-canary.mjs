import fs from "node:fs";
import {chromium} from "playwright";

const baseUrl=String(process.env.ATOMIC_CANARY_BASE_URL||"").replace(/\/$/,"");
const session=JSON.parse(fs.readFileSync(process.env.ATOMIC_CANARY_SESSION_FILE||"/tmp/wb-portal-access-button-canary-session.json","utf8"));
if(!baseUrl)throw new Error("ATOMIC_CANARY_BASE_URL_required");
const company="7edf1812-b5e9-4b5c-addf-95d2339362b3",results=[];
const browser=await chromium.launch({headless:true});
try{
 for(const [name,viewport] of [["desktop",{width:1440,height:1000}],["mobile",{width:390,height:844}]]){
  const context=await browser.newContext({viewport});await context.addCookies([{name:"wb_session",value:session.token,url:baseUrl,httpOnly:true,sameSite:"Lax"},{name:"wb_csrf",value:session.csrf,url:baseUrl,sameSite:"Lax"}]);
  const page=await context.newPage();page.setDefaultTimeout(30000);const pageErrors=[],consoleErrors=[],requests=[];
  page.on("pageerror",error=>pageErrors.push(error.message));page.on("console",message=>{if(message.type()==="error")consoleErrors.push(message.text().replace(/[A-Za-z0-9_-]{30,}/g,"[REDACTED]"))});page.on("response",response=>{if(/configuration\/(regions\/validate|drafts|versions\/[^/]+\/(preview|self-approve-activate))/.test(response.url()))requests.push({method:response.request().method(),status:response.status(),path:new URL(response.url()).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/ig,"[UUID]")})});
  await page.goto(`${baseUrl}/configuration?company=${company}&tab=regions&parameter=A08`,{waitUntil:"domcontentloaded"});
  const button=page.locator("[data-board-form]");await button.waitFor();await page.locator('[data-region-field="place"]').waitFor();
  await button.click();await page.getByText("Vorschau vor Aktivierung",{exact:true}).waitFor();const previewText=await page.locator("#draft-status").innerText();
  if(!previewText.includes("DE271")||!previewText.includes("Geographischer Koordinatenradius"))throw new Error(`${name}_precision_preview_missing`);
  await page.getByRole("button",{name:"Vorschau geprüft – jetzt aktivieren"}).click();await page.getByText(/wurde durch den Vorstand freigegeben und aktiviert/).waitFor();
  const statusText=await page.locator("#draft-status").innerText();results.push({name,viewport,previewPrecise:true,successVisible:/freigegeben und aktiviert/.test(statusText),requests,pageErrors,consoleErrors});await context.close();
 }
 const passed=results.every(result=>result.previewPrecise&&result.successVisible&&result.pageErrors.length===0&&result.consoleErrors.length===0&&result.requests.some(request=>request.path.endsWith("/self-approve-activate")&&request.status===200)&&result.requests.every(request=>request.status<400));
 console.log(JSON.stringify({passed,isolated:true,results},null,2));if(!passed)process.exitCode=1;
}finally{await browser.close()}
