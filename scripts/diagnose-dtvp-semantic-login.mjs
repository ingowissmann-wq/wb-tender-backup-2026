import pg from "pg";import{readFileSync}from"node:fs";import{decryptSecret}from"../platform/portal-credentials.mjs";import{authenticatePortalWithBrowser}from"../platform/semantic-browser-auth.mjs";
const db=new pg.Client({connectionString:process.env.DATABASE_URL||readFileSync(process.env.DATABASE_URL_FILE,"utf8").trim()});await db.connect();
try{
 const portal=(await db.query("SELECT * FROM tender.portal_registry WHERE id='7ea3823b-1e5c-4696-9dda-0303427544d0'::uuid")).rows[0];
 const encrypted=(await db.query("SELECT * FROM tender.portal_credential_secrets WHERE id='35b60bca-5af1-43e9-a544-49bfdd2a4328'::uuid AND status='ACTIVE'")).rows[0];
 const result=await authenticatePortalWithBrowser({portal,credential:decryptSecret(encrypted),targetUrl:"https://www.dtvp.de/Center/secured/company/welcome.do",timeoutMs:30000,headless:true});
 let authenticatedHost=null;try{authenticatedHost=result.authenticatedUrl?new URL(result.authenticatedUrl).hostname:null}catch{}
 console.log(JSON.stringify({resultCode:result.resultCode,failurePhase:result.failurePhase||null,failureClass:result.failureClass||null,failureReason:result.failureReason||null,authenticatedHost,hasSession:Boolean(result.session),mfaRequired:result.resultCode==="MFA_BESTÄTIGUNG_ERFORDERLICH"}));
}finally{await db.end()}
