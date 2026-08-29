import fs from "node:fs";
import http from "node:http";
import {chromium} from "playwright";

const baseUrl=String(process.env.ATOMIC_CANARY_BASE_URL||"").replace(/\/$/,"");
const session=JSON.parse(fs.readFileSync(process.env.ATOMIC_CANARY_SESSION_FILE||"/tmp/wb-portal-access-button-canary-session.json","utf8"));
if(!baseUrl)throw new Error("ATOMIC_CANARY_BASE_URL_required");
const company="7edf1812-b5e9-4b5c-addf-95d2339362b3",results=[];
const target=new URL(baseUrl),proxy=http.createServer((request,response)=>{const path=String(request.url||"/").replace(/^\/admin\/ausschreibungen/,"").replace(/^\/api\/tender(?=\/|$)/,"/api")||"/",upstream=http.request({hostname:target.hostname,port:target.port,path,method:request.method,headers:{...request.headers,host:target.host}},upstreamResponse=>{response.writeHead(upstreamResponse.statusCode||502,upstreamResponse.headers);upstreamResponse.pipe(response)});upstream.on("error",()=>{response.writeHead(502);response.end("upstream unavailable")});request.pipe(upstream)});
await new Promise(resolve=>proxy.listen(0,"127.0.0.1",resolve));const browserBaseUrl=`http://127.0.0.1:${proxy.address().port}`;
const browser=await chromium.launch({headless:true});
try{
 for(const [name,viewport] of [["desktop",{width:1440,height:1000}],["mobile",{width:390,height:844}]]){
  const context=await browser.newContext({viewport});await context.addCookies([{name:"wb_session",value:session.token,url:browserBaseUrl,httpOnly:true,sameSite:"Lax"},{name:"wb_csrf",value:session.csrf,url:browserBaseUrl,sameSite:"Lax"}]);
  const page=await context.newPage();page.setDefaultTimeout(30000);const pageErrors=[],consoleErrors=[],requests=[];
  page.on("pageerror",error=>pageErrors.push(error.message));page.on("console",message=>{if(message.type()==="error")consoleErrors.push(message.text().replace(/[A-Za-z0-9_-]{30,}/g,"[REDACTED]"))});page.on("response",response=>{if(/configuration\/(regions\/validate|drafts|versions\/[^/]+\/(preview|self-approve-activate))/.test(response.url()))requests.push({method:response.request().method(),status:response.status(),path:new URL(response.url()).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/ig,"[UUID]")})});
  await page.goto(`${browserBaseUrl}/configuration?company=${company}&tab=regions&parameter=A08`,{waitUntil:"domcontentloaded"});
  const button=page.locator("[data-board-form]");try{await button.waitFor()}catch(error){console.log(JSON.stringify({phase:"board_button_missing",name,url:page.url(),body:(await page.locator("body").innerText()).slice(0,1200),pageErrors,consoleErrors},null,2));throw error}await page.locator('[data-region-field="place"]').waitFor();
  await button.click();await page.getByText("Vorschau vor Aktivierung",{exact:true}).waitFor();const previewText=await page.locator("#draft-status").innerText();
  if(!previewText.includes("DE271")||!previewText.includes("Geographischer Koordinatenradius"))throw new Error(`${name}_precision_preview_missing`);
  await page.getByRole("button",{name:"Vorschau geprüft – jetzt aktivieren"}).click();await page.getByText(/wurde durch den Vorstand freigegeben und aktiviert/).waitFor();
  const statusText=await page.locator("#draft-status").innerText();results.push({name,viewport,previewPrecise:true,successVisible:/freigegeben und aktiviert/.test(statusText),requests,pageErrors,consoleErrors});await context.close();
 }
 const passed=results.every(result=>result.previewPrecise&&result.successVisible&&result.pageErrors.length===0&&result.consoleErrors.length===0&&result.requests.some(request=>request.path.endsWith("/self-approve-activate")&&request.status===200)&&result.requests.every(request=>request.status<400));
 console.log(JSON.stringify({passed,isolated:true,results},null,2));if(!passed)process.exitCode=1;
}finally{await browser.close();await new Promise(resolve=>proxy.close(resolve))}
