import { readFileSync } from "node:fs";
import { statfsSync } from "node:fs";
import pg from "pg";

const connectionString = process.env.DATABASE_URL || readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim();
const pool = new pg.Pool({ connectionString, max: 1, options: "-c default_transaction_read_only=on" });
try {
  const rows = (await pool.query(`SELECT source.source_code,source.enabled,source.kill_switch,source.last_success_at,source.last_failure_at,source.next_run_at,
    latest.status latest_status,latest.finished_at latest_finished_at
    FROM tender.scheduler_sources source
    LEFT JOIN LATERAL(SELECT status,finished_at FROM tender.scheduler_runs run WHERE run.source_code=source.source_code ORDER BY started_at DESC LIMIT 1) latest ON true
    WHERE source.source_code=ANY($1::text[]) ORDER BY source.source_code`, [["DOE", "TED"]])).rows;
  const now = Date.now(), unhealthy = rows.filter((row) => !row.enabled || row.kill_switch || !row.last_success_at || now - new Date(row.last_success_at).getTime() > 30 * 60 * 60 * 1000 || ["FAILED", "PARTIAL_FAILURE"].includes(row.latest_status));
  const cleanup = (await pool.query("SELECT * FROM tender.tender_cleanup_runs ORDER BY started_at DESC LIMIT 1")).rows[0];
  const inboxPipeline = (await pool.query("SELECT * FROM tender.inbox_pipeline_runs ORDER BY started_at DESC LIMIT 1")).rows[0];
  const reimports = Number((await pool.query(`SELECT count(*) n FROM tender.tender_tombstones tombstone JOIN tender.tenders tender USING(source_code,external_id)
    WHERE tombstone.tombstone_status='DELETED' AND tender.source_lifecycle_status<>'TOMBSTONED' AND tender.offer_deadline<now()`)).rows[0].n);
  const reviewGroup = Number((await pool.query("SELECT count(*) n FROM tender.tender_expiry_reviews WHERE review_status='OPEN'")).rows[0].n);
  const previousReviewGroup = Number((await pool.query("SELECT coalesce((metrics->>'reviewGroupCount')::bigint,0) n FROM tender.tender_cleanup_runs WHERE status='SUCCESS' AND id<>coalesce($1::uuid,'00000000-0000-0000-0000-000000000000'::uuid) ORDER BY started_at DESC LIMIT 1", [cleanup?.id || null])).rows[0]?.n || 0);
  const orphanSourcePages = Number((await pool.query("SELECT count(*) n FROM tender.import_source_pages page WHERE NOT EXISTS(SELECT 1 FROM tender.import_raw_payloads raw WHERE raw.source_page_id=page.id)")).rows[0].n);
  const orphanDocumentBlobs = Number((await pool.query(`SELECT count(*) n FROM tender.document_blobs blob
    WHERE NOT EXISTS(SELECT 1 FROM tender.enrichment_document_blobs link WHERE link.payload_sha256=blob.payload_sha256)
      AND NOT EXISTS(SELECT 1 FROM tender.generated_documents generated WHERE generated.sha256=blob.payload_sha256)`)).rows[0].n);
  let freePercent=null;
  try { const fs=statfsSync('/run/secrets/database_url'); freePercent=Number(fs.bavail)/Number(fs.blocks)*100; } catch {}
  const cleanupUnhealthy=!cleanup || cleanup.status!=='SUCCESS' || !cleanup.finished_at || now-new Date(cleanup.finished_at).getTime()>30*60*60*1000;
  const anomalous=Boolean(cleanup && (Number(cleanup.deleted_count)>5000 || (Number(cleanup.checked_count)>0 && Number(cleanup.deleted_count)/Number(cleanup.checked_count)>0.25)));
  const reviewGrowthWarning=previousReviewGroup>0 && reviewGroup-previousReviewGroup>Math.max(1000,Math.ceil(previousReviewGroup*0.10));
  const diskCritical=freePercent!==null && freePercent<10, diskWarning=freePercent!==null && freePercent<20;
  const inboxPipelineUnhealthy=!inboxPipeline || inboxPipeline.status!=='SUCCESS' || !inboxPipeline.finished_at || now-new Date(inboxPipeline.finished_at).getTime()>30*60*60*1000;
  const warnings=[...(diskWarning?["DISK_FREE_BELOW_20_PERCENT"]:[]),...(reviewGrowthWarning?["EXPIRY_REVIEW_GROUP_GROWTH"]:[]),...((orphanSourcePages||orphanDocumentBlobs)?["ORPHANED_DATABASE_FILES_PRESENT"]:[])];
  const healthy=rows.length===2 && unhealthy.length===0 && !cleanupUnhealthy && !inboxPipelineUnhealthy && !anomalous && reimports===0 && !diskCritical;
  console.log(JSON.stringify({ healthy,status:healthy?(warnings.length?'warning':'healthy'):'unhealthy',warnings,sources:rows.map((row)=>({sourceCode:row.source_code,enabled:row.enabled,killSwitch:row.kill_switch,lastSuccessAt:row.last_success_at,lastFailureAt:row.last_failure_at,nextRunAt:row.next_run_at,latestStatus:row.latest_status,latestFinishedAt:row.latest_finished_at})),inboxPipeline:inboxPipeline?{lastRunAt:inboxPipeline.finished_at,status:inboxPipeline.status,checked:Number(inboxPipeline.checked_count),matched:Number(inboxPipeline.matched_count),inboxCreated:Number(inboxPipeline.inbox_created_count),regionsCreated:Number(inboxPipeline.region_created_count),skipped:Number(inboxPipeline.skipped_count),errors:Number(inboxPipeline.error_count)}:null,cleanup:cleanup?{lastRunAt:cleanup.finished_at,status:cleanup.status,checked:Number(cleanup.checked_count),deleted:Number(cleanup.deleted_count),tombstones:Number(cleanup.tombstone_count),ambiguous:Number(cleanup.ambiguous_count),reviewGroup,protected:Number(cleanup.protected_count),filesDeleted:Number(cleanup.deleted_file_count),fileBytesDeleted:Number(cleanup.deleted_file_bytes),errors:Number(cleanup.error_count),durationMs:Number(cleanup.duration_ms),freeBytes:cleanup.filesystem_free_bytes_after}:null,freePercent,diskWarning,diskCritical,reviewGrowthWarning,orphanSourcePages,orphanDocumentBlobs,anomalousDeletionVolume:anomalous,expiredTombstoneReimports:reimports}));
  if (!healthy) process.exitCode=1;
} finally { await pool.end(); }
