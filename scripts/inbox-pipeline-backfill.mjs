import {readFileSync} from "node:fs";
import pg from "pg";
import {runInboxPipeline} from "../platform/inbox-pipeline.mjs";

const cutoff=process.env.INBOX_BACKFILL_CUTOFF||"2026-08-05T07:22:25.910786Z";
if(Number.isNaN(Date.parse(cutoff)))throw new Error("invalid inbox backfill cutoff");
const limit=Math.max(1,Math.min(25000,Number(process.env.INBOX_BACKFILL_LIMIT||10000)));
const connectionString=process.env.DATABASE_URL||readFileSync(process.env.DATABASE_URL_FILE,"utf8").trim();
const pool=new pg.Pool({connectionString,max:3,options:"-c tender.pipeline_job_id=DAILY_INBOX_PIPELINE"});
try{
  const ids=(await pool.query(`SELECT DISTINCT t.id FROM tender.tenders t JOIN tender.current_service_relevance r ON r.tender_id=t.id AND r.primary_company=true AND r.relevance_status='RELEVANT' AND r.service_scope_gate='PASSED'
    WHERE t.data_class='PUBLIC_REAL' AND t.source_lifecycle_status='ACTIVE' AND t.created_at>$1 AND (t.offer_deadline IS NULL OR t.offer_deadline>now())
      AND NOT EXISTS(SELECT 1 FROM tender.tender_tombstones tomb WHERE tomb.source_code=t.source_code AND tomb.external_id=t.external_id AND tomb.tombstone_status='DELETED')
      AND NOT EXISTS(SELECT 1 FROM tender.region_evaluations e WHERE e.tender_id=t.id AND e.company_id=r.company_id AND e.lot_id IS NULL AND e.source_data->>'pipelineVersion'='wb-daily-inbox-pipeline/1.0.0')
    ORDER BY t.id LIMIT $2`,[cutoff,limit])).rows.map(row=>row.id);
  const result=await runInboxPipeline(pool,{tenderIds:ids,runKind:"BACKFILL",cutoffAt:cutoff,batchSize:Number(process.env.INBOX_PIPELINE_BATCH_SIZE||100)});
  console.log(JSON.stringify({cutoff,candidates:ids.length,...result}));
}finally{await pool.end()}
