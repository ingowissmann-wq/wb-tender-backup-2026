import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import {decryptSecret} from "../platform/portal-credentials.mjs";
import {downloadAuthenticatedDeutscheEvergabeEvaArchive} from "../platform/semantic-browser-auth.mjs";

const tenderGuid=process.argv[2];
const pool=new pg.Pool({connectionString:fs.readFileSync(process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8").trim(),max:1});
try{
  const row=(await pool.query(`SELECT p.*,c.ciphertext,c.iv,c.auth_tag,c.key_version FROM tender.portal_registry p JOIN LATERAL(SELECT * FROM tender.portal_credential_secrets x WHERE x.portal_id=p.id AND x.status='ACTIVE' ORDER BY version DESC LIMIT 1)c ON true WHERE p.adapter_id='deutsche-evergabe'`)).rows[0];
  const result=await downloadAuthenticatedDeutscheEvergabeEvaArchive({portal:row,credential:decryptSecret(row),tenderGuid});
  console.log(JSON.stringify({status:result.status,navigationPath:result.navigationPath,mime:result.mime,bytes:result.buffer.length,sha256:crypto.createHash("sha256").update(result.buffer).digest("hex"),externalWrite:false}));
}finally{await pool.end()}
