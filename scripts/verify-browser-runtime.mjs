import {access,constants} from 'node:fs/promises';
import {chromium} from 'playwright';
import crypto from 'node:crypto';
const executablePath=process.env.CHROMIUM_EXECUTABLE_PATH;
if(!executablePath?.startsWith('/'))throw new Error('browser_runtime_executable_required');
await access(executablePath,constants.X_OK);
const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 const context=await browser.newContext({serviceWorkers:'block'});
 await context.route('**/*',route=>route.abort());
 const page=await context.newPage();
 await page.setContent('<!doctype html><html lang="de"><meta charset="utf-8"><title>WB-Tender Laufzeitprüfung</title><h1>Lokale Browserprüfung</h1><form method="post"><input name="company" value="SYNTHETIC"><button>Prüfen</button></form></html>');
 if(await page.title()!=='WB-Tender Laufzeitprüfung'||await page.locator('[name=company]').inputValue()!=='SYNTHETIC')throw new Error('browser_runtime_dom_failed');
 const screenshot=await page.screenshot();if(screenshot.length<1000)throw new Error('browser_runtime_render_failed');
 console.log(JSON.stringify({browserRuntime:'PASS',version:browser.version(),networkBlocked:true,dom:true,render:true,screenshotSha256:crypto.createHash('sha256').update(screenshot).digest('hex')}));
 await context.close();
}finally{await browser.close();}
