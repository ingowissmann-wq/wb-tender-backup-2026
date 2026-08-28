import fs from "node:fs";
import pg from "pg";
import { chromium } from "playwright";
import { createFixedScopedPool, loadBackgroundScope } from "../platform/scoped-pg-pool.mjs";
import { verifyTedNoticeArtifact } from "../platform/ted-notice-canary.mjs";

const connectionString = process.env.DATABASE_URL || fs.readFileSync(
  process.env.DATABASE_URL_FILE || "/run/secrets/database_url", "utf8",
).trim();
const rawPool = new pg.Pool({connectionString,max:1,options:[
  "-c default_transaction_read_only=on -c statement_timeout=120000",
  process.env.DATABASE_SESSION_OPTIONS,
].filter(Boolean).join(" ")});
const pool = createFixedScopedPool(rawPool,await loadBackgroundScope(rawPool)).pool;
const client = await pool.connect();
let browser;
try {
  await client.query("BEGIN READ ONLY");
  const tender = (await client.query(`SELECT tender.id,tender.external_id,tender.offer_deadline,
      array_agg(lot.external_id ORDER BY lot.external_id) lot_keys
    FROM tender.tenders tender
    JOIN tender.lots lot ON lot.tender_id=tender.id
    WHERE tender.source_code='TED' AND tender.source_lifecycle_status='ACTIVE'
      AND tender.offer_deadline>now() AND tender.external_id~'^[0-9]+-[0-9]{4}$'
      AND lot.external_id~'^LOT-[0-9]{4}$'
    GROUP BY tender.id
    HAVING count(*)>1
    ORDER BY (tender.wb_relevance_status='RELEVANT') DESC,tender.offer_deadline,count(*) DESC,tender.id
    LIMIT 1`)).rows[0];
  if (!tender) throw new Error("ACTIVE_TED_MULTI_LOT_FIXTURE_NOT_FOUND");
  const sourceUrl = `https://ted.europa.eu/en/notice/${encodeURIComponent(tender.external_id)}/html`;
  const response = await fetch(sourceUrl,{method:"GET",redirect:"error",signal:AbortSignal.timeout(60_000),headers:{accept:"text/html"}});
  const content = Buffer.from(await response.arrayBuffer());
  const verification = verifyTedNoticeArtifact({
    content,contentType:response.headers.get("content-type"),status:response.status,
    externalId:tender.external_id,lotKeys:tender.lot_keys,
  });
  if (!verification.valid) throw Object.assign(new Error("TED_NOTICE_ARTIFACT_INVALID"),{verification});
  browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:["--no-sandbox","--disable-dev-shm-usage"]});
  const context = await browser.newContext({javaScriptEnabled:false,serviceWorkers:"block"});
  const page = await context.newPage();
  let blockedBrowserRequests=0;
  await page.route("**/*",route=>{blockedBrowserRequests++;return route.abort()});
  await page.setContent(content.toString("utf8"),{waitUntil:"domcontentloaded",timeout:30_000});
  const rendered = await page.locator("body").innerText();
  const browserTenderPresent = rendered.includes(tender.external_id);
  const browserMissingLots = tender.lot_keys.filter(lotKey=>!rendered.includes(lotKey));
  await context.close();
  if (!browserTenderPresent || browserMissingLots.length) throw Object.assign(new Error("TED_BROWSER_RENDER_VALIDATION_FAILED"),{browserTenderPresent,browserMissingLots});
  await client.query("ROLLBACK");
  console.log(JSON.stringify({
    capturedAt:new Date().toISOString(),transaction:"READ_ONLY_ROLLED_BACK",
    portal:"ted.europa.eu",adapterId:"ted-discovery",sourceUrl,
    tenderId:tender.id,externalId:tender.external_id,offerDeadline:tender.offer_deadline,
    lotKeys:tender.lot_keys,verification,
    browser:{rendered:true,tenderIdPresent:browserTenderPresent,missingLots:browserMissingLots,
      externalNetworkRequestsAllowed:0,blockedBrowserRequests},
    requestMethods:["GET"],credentialsUsed:false,cookiesPersisted:false,
    externalWrite:false,transmitted:false,passed:true,
  },null,2));
} catch (error) {
  await client.query("ROLLBACK").catch(()=>{});
  throw error;
} finally {
  await browser?.close().catch(()=>{});
  client.release();
  await rawPool.end();
}
