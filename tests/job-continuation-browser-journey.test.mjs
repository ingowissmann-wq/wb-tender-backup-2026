import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "playwright";

const browserPath=process.env.CHROMIUM_EXECUTABLE_PATH||chromium.executablePath(),browserAvailable=existsSync(browserPath),
  ui=readFileSync(new URL("../platform/assets/autopilot-navigation.js",import.meta.url));

test("terminal account continuation renders exact safe action without mutation",{skip:!browserAvailable},async(t)=>{
  const jobId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",tenderId="11111111-1111-4111-8111-111111111111",
    companyId="22222222-2222-4222-8222-222222222222",portalId="33333333-3333-4333-8333-333333333333",
    requests=[];
  const server=createServer((req,res)=>{
    requests.push({method:req.method,url:req.url});
    if(req.url.startsWith("/admin/ausschreibungen/autopilot/overview")){
      res.setHeader("content-type","text/html");
      return res.end(`<!doctype html><body data-base="/admin/ausschreibungen" data-api="/api/tender"><nav id="autopilot-nav"></nav><p data-portal-status="${portalId}" data-job-id="${jobId}">Job-ID ${jobId}</p><section id="autopilot-content"></section><script src="/autopilot-navigation.js"></script></body>`);
    }
    if(req.url==="/autopilot-navigation.js"){
      res.setHeader("content-type","application/javascript; charset=utf-8");
      return res.end(ui);
    }
    if(req.url===`/api/tender/portal-access/jobs/${jobId}`)return json(res,{
      job_id:jobId,action_type:"TEST_DOCUMENT_FETCH",status:"CANCELLED",queue_status:"CANCELLED",
      current_step:"HUMAN_ACTION_REQUIRED",progress_percent:100,terminal_result:"ACCOUNT_SETUP_REQUIRED",
      created_at:new Date().toISOString(),finished_at:new Date().toISOString(),
      continuation:{status:"ACCOUNT_SETUP_REQUIRED",title:"Portalzugang erforderlich",
        message:"Für diese Gesellschaft und dieses Portal muss ein Zugang eingerichtet oder die sichere Sitzung erneuert werden.",
        actionType:"MANAGE_PORTAL_ACCESS",actionLabel:"Gesellschaftsgebundenen Portalzugang öffnen",
        tenderId,companyId,portalId,lotKey:"LOT-0007",enrichmentVersionId:null,
        externalWrite:false,automaticExternalAction:false},
    });
    if(req.url.startsWith("/api/tender/"))return json(res,{items:[],totals:{},summary:{}});
    res.statusCode=404;return json(res,{error:"fixture_not_found"});
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>server.close());
  const browser=await chromium.launch({headless:true,executablePath:browserPath});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.addInitScript(({jobId,portalId})=>localStorage.setItem(`wb-tender-job:${jobId}`,JSON.stringify({jobId,portalId})),{jobId,portalId});
  await page.goto(`http://127.0.0.1:${server.address().port}/admin/ausschreibungen/autopilot/overview`);
  const action=page.locator(".job-continuation-action");
  await action.waitFor({timeout:10000});
  assert.equal(await action.textContent(),"Gesellschaftsgebundenen Portalzugang öffnen");
  const target=new URL(await action.getAttribute("href"),page.url());
  assert.match(target.pathname,/\/autopilot\/portal-access$/);
  assert.equal(target.searchParams.get("tender"),tenderId);
  assert.equal(target.searchParams.get("company"),companyId);
  assert.equal(target.searchParams.get("lot"),"LOT-0007");
  assert.equal(target.searchParams.get("portal"),portalId);
  assert.equal(target.searchParams.get("focus"),"credentials");
  assert.equal(requests.some(request=>request.method!=="GET"),false,"continuation rendering must not mutate state");
  assert.equal(requests.filter(request=>request.url.includes(`/portal-access/jobs/${jobId}`)).length,1);
});

const json=(res,value)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify(value))};
