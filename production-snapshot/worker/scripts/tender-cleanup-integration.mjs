import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { runTenderCleanup } from "../platform/tender-cleanup.mjs";

const connectionString=process.env.DATABASE_URL || readFileSync(process.env.DATABASE_URL_FILE,"utf8").trim();
const pool=new pg.Pool({connectionString,max:4});
const now=new Date("2026-01-20T12:00:00Z");
const sha=(digit)=>String(digit).repeat(64);
const normalized=(externalId,{deadline="2026-01-15",status="closed",lots=["2026-01-15"]}={})=>({
  sourceCode:"TED",externalId,offerDeadline:deadline,sourceTimestamp:"2026-01-18T10:00:00Z",sourceStatus:status,
  raw:{"deadline-receipt-tender-date-lot":lots},
});
async function tender(externalId,{deadline="2026-01-15T23:00:00Z",status="closed",lots=["2026-01-15"],hashDigit="1"}={}) {
  const id=(await pool.query(`INSERT INTO tender.tenders(data_class,source_code,external_id,buyer,title,source_url,source_timestamp,offer_deadline,raw_sha256,source_lifecycle_status)
    VALUES('PUBLIC_REAL','TED',$1,'test buyer','test tender','https://example.invalid/tender','2026-01-18T10:00:00Z',$2,$3,'ACTIVE') RETURNING id`,[externalId,deadline,sha(hashDigit)])).rows[0].id;
  await pool.query("SELECT set_config('wb_tender.suppress_autopilot_enqueue','true',false)");
  await pool.query(`INSERT INTO tender.tender_versions(tender_id,version,source_sha256,normalized_data,source_timestamp)
    VALUES($1,1,$2,$3::jsonb,'2026-01-18T10:00:00Z')`,[id,sha(hashDigit),JSON.stringify(normalized(externalId,{deadline:deadline?deadline.slice(0,10):null,status,lots}))]);
  return id;
}

try {
  await pool.query("INSERT INTO tender.sources(code,name,interface,base_url,enabled) VALUES('TED','TED','TEST','https://example.invalid',true) ON CONFLICT DO NOTHING");
  const deletable=await tender("expired-closed",{hashDigit:"1"});
  const attachmentTender=await tender("expired-attachment",{hashDigit:"2"});
  const active=await tender("active",{deadline:"2026-02-15T23:00:00Z",status:"open",lots:["2026-02-15"],hashDigit:"3"});
  const activeLot=await tender("active-lot",{status:"closed",lots:["2026-01-15","2026-02-15"],hashDigit:"4"});
  const missing=await tender("missing-deadline",{deadline:null,status:"closed",lots:[],hashDigit:"5"});
  const unknown=await tender("unknown-source-state",{status:"cn-standard",hashDigit:"6"});
  const protectedTender=await tender("protected-expired",{hashDigit:"7"});
  await pool.query("INSERT INTO tender.favorites(user_id,tender_id) VALUES('00000000-0000-4000-8000-000000000111',$1)",[protectedTender]);

  const enrichment=(await pool.query(`INSERT INTO tender.enrichment_versions(tender_id,version,source_code,notice_identifier,retrieved_at,source_url,payload_sha256,raw_payload,raw_content_type,structured_data,quality_summary,mapper_version,parser_version)
    VALUES($1,1,'TED','expired-attachment',now(),'https://example.invalid/source',$2,'source'::bytea,'application/octet-stream','{}','{}','test','test') RETURNING id`,[attachmentTender,sha("8")])).rows[0].id;
  await pool.query(`INSERT INTO tender.enrichment_documents(enrichment_version_id,source_url,fetch_status,mime_type,payload_sha256,content,content_size)
    VALUES($1,'https://example.invalid/file','SUCCESS','application/pdf',$2,$3,$4)`,[enrichment,sha("9"),Buffer.from("test attachment"),Buffer.byteLength("test attachment")]);
  const page=(await pool.query(`INSERT INTO tender.import_source_pages(source_code,page_index,source_url,content_type,raw_bytes,payload_sha256,retrieved_at,parser_version,mapper_version)
    VALUES('TED',0,'https://example.invalid/page','application/json','page'::bytea,$1,now(),'test','test') RETURNING id`,[sha("a")])).rows[0].id;
  await pool.query(`INSERT INTO tender.import_raw_payloads(source_page_id,source_code,record_index,external_id,raw_json,raw_text,payload_sha256,retrieved_at,parser_version,mapper_version,processing_status,replay_status)
    VALUES($1,'TED',0,'expired-closed','{}','{}',$2,now(),'test','test','IMPORTED','SUCCEEDED')`,[page,sha("b")]);

  const first=await runTenderCleanup(pool,{syncSucceeded:true,syncRunIds:[],batchSize:1,now,runKind:"MANUAL",vacuum:false});
  assert.equal(first.passed,true);
  assert.equal(first.deleted,2);
  assert.equal(first.protected,1);
  assert.equal(first.tombstones,3);
  assert.equal(first.attachmentsDeleted,1);
  assert.equal(first.reviewGroupCount,2);
  assert.equal(Number((await pool.query("SELECT count(*) n FROM tender.tenders WHERE id=ANY($1::uuid[])",[[deletable,attachmentTender]])).rows[0].n),0);
  assert.equal(Number((await pool.query("SELECT count(*) n FROM tender.tenders WHERE id=ANY($1::uuid[])",[[active,activeLot,missing,unknown]])).rows[0].n),4);
  const protectedRow=(await pool.query("SELECT source_lifecycle_status,title FROM tender.tenders WHERE id=$1",[protectedTender])).rows[0];
  assert.equal(protectedRow.source_lifecycle_status,"TOMBSTONED");
  assert.equal(Number((await pool.query("SELECT count(*) n FROM tender.favorites WHERE tender_id=$1",[protectedTender])).rows[0].n),1);
  assert.equal(Number((await pool.query("SELECT count(*) n FROM tender.enrichment_documents")).rows[0].n),0);
  assert.equal(Number((await pool.query("SELECT count(*) n FROM tender.import_source_pages WHERE id=$1",[page])).rows[0].n),0);

  const second=await runTenderCleanup(pool,{syncSucceeded:true,syncRunIds:[],batchSize:2,now,runKind:"MANUAL",vacuum:false});
  assert.equal(second.passed,true);
  assert.equal(second.deleted,0);
  assert.equal(second.protected,0);
  assert.equal(Number((await pool.query("SELECT count(*) n FROM tender.tender_tombstones WHERE tombstone_status='DELETED'")).rows[0].n),3);
  console.log(JSON.stringify({passed:true,first:{deleted:first.deleted,protected:first.protected,tombstones:first.tombstones,attachmentsDeleted:first.attachmentsDeleted,reviewGroupCount:first.reviewGroupCount},second:{deleted:second.deleted,protected:second.protected,tombstones:second.tombstones},activeRetained:4,customerReferencesRetained:1,orphanSourcePages:0}));
} finally {
  await pool.end();
}
