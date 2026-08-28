import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";

const connectionString=process.env.DATABASE_URL||fs.readFileSync(
  process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8",
).trim();
const apply=process.env.APPLY_DOCUMENT_SCAN_RETRY==="true";
const client=new pg.Client({connectionString,options:process.env.DATABASE_SESSION_OPTIONS||undefined});

await client.connect();
try{
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('wb-document-scan-retry',0))");
  const transmittedBefore=Number((await client.query(
    "SELECT count(*) count FROM tender.final_preflight_contexts WHERE transmitted IS TRUE",
  )).rows[0].count);
  const rows=(await client.query(`SELECT scan.id,scan.payload_sha256,document.content
    FROM tender.document_malware_scans scan
    JOIN tender.enrichment_documents document
      ON document.id=scan.document_id AND document.payload_sha256=scan.payload_sha256
    WHERE scan.status='QUARANTINED' AND scan.detail_code IN('scan_timeout','size_not_scannable')
      AND document.procurement_relevant AND document.content IS NOT NULL
      AND octet_length(document.content)<=100*1024*1024
    ORDER BY scan.id FOR UPDATE OF scan`)).rows;
  let hashMismatch=0;
  for(const row of rows){
    const actual=crypto.createHash("sha256").update(row.content).digest("hex");
    if(actual!==row.payload_sha256){hashMismatch++;continue}
    await client.query(`UPDATE tender.document_malware_scans
      SET next_retry_at=now() WHERE id=$1 AND status='QUARANTINED'`,[row.id]);
  }
  const queued=rows.length-hashMismatch;
  const transmittedAfter=Number((await client.query(
    "SELECT count(*) count FROM tender.final_preflight_contexts WHERE transmitted IS TRUE",
  )).rows[0].count);
  if(hashMismatch||transmittedBefore||transmittedAfter)throw new Error(
    `document_scan_retry_gate_failed:${JSON.stringify({attempted:rows.length,hashMismatch,transmittedBefore,transmittedAfter})}`,
  );
  if(apply)await client.query("COMMIT");else await client.query("ROLLBACK");
  console.log(JSON.stringify({passed:true,mode:apply?"APPLIED":"DRY_RUN_ROLLED_BACK",attempted:rows.length,
    queued,hashMismatch,externalSubmission:false,transmitted:false},null,2));
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{await client.end()}
