import pg from "pg";
import {readFileSync} from "node:fs";
import {decryptSecret} from "../platform/portal-credentials.mjs";

const pool=new pg.Pool({connectionString:readFileSync(process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8").trim(),max:1});
const row=(await pool.query(`SELECT s.*,p.display_name,p.adapter_id,p.canonical_domain,c.username_masked,pc.company_id,l.legal_name
  FROM tender.portal_read_sessions s
  JOIN tender.portal_registry p ON p.id=s.portal_id
  JOIN tender.portal_credential_secrets c ON c.id=s.credential_id
  LEFT JOIN tender.portal_credential_companies pc ON pc.credential_id=c.id
  LEFT JOIN tender.enterprise_company_links l ON l.company_id=pc.company_id
  WHERE p.adapter_id=$1 AND ($2::text IS NULL OR l.legal_name=$2)
  ORDER BY s.created_at DESC LIMIT 1`,[process.argv[2]||"deutsche-evergabe",process.argv[3]||null])).rows[0];
if(!row)throw new Error("portal_session_not_found");
const session=decryptSecret(row),cookies=session.cookies||session.storageState?.cookies||[],origins=session.storageState?.origins||[],sessionOrigins=session.sessionStorage||[];
console.log(JSON.stringify({
  sessionId:row.id,portal:row.display_name,adapter:row.adapter_id,company:row.legal_name,companyId:row.company_id,
  account:row.username_masked,createdAt:row.created_at,expiresAt:row.expires_at,status:row.status,
  payloadKeys:Object.keys(session).sort(),cookieCount:cookies.length,
  cookies:cookies.map(({name,domain,path,sameSite,secure,httpOnly,expires})=>({name,domain,path,sameSite,secure,httpOnly,expires})),
  storageStatePresent:Boolean(session.storageState),originCount:origins.length,
  origins:origins.map(origin=>({origin:origin.origin,localStorageEntries:Array.isArray(origin.localStorage)?origin.localStorage.length:0})),
  sessionStorageOrigins:sessionOrigins.map(origin=>({origin:origin.origin,entries:Array.isArray(origin.entries)?origin.entries.length:0}))
},null,2));
await pool.end();
