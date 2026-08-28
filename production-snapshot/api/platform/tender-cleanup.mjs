import { statfsSync } from "node:fs";

export const CLEANUP_VERSION = "wb-tender-expiry-cleanup/2.2.0";
export const DEFAULT_CLEANUP_BATCH_SIZE = 100;
export const PUBLIC_CLEANUP_SOURCES = Object.freeze(["TED", "DOE"]);

const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
const explicitZone = /(Z|[+-]\d{2}:?\d{2})$/i;
const berlinFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const berlinParts = (date) => Object.fromEntries(berlinFormatter.formatToParts(date)
  .filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
export const berlinDay = (date) => {
  const part = berlinParts(date);
  return `${part.year}-${part.month}-${part.day}`;
};

function berlinStartOfNextDay(day) {
  if (!dateOnly.test(String(day || ""))) return null;
  const [year, month, date] = day.split("-").map(Number);
  const desired = new Date(Date.UTC(year, month - 1, date + 1));
  let candidate = new Date(desired);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const part = berlinParts(candidate);
    const observed = Date.UTC(Number(part.year), Number(part.month) - 1, Number(part.day), Number(part.hour), Number(part.minute), Number(part.second));
    candidate = new Date(candidate.getTime() + desired.getTime() - observed);
  }
  return candidate;
}

export function bindingDeadline(value) {
  const raw = String(value || "").trim();
  if (!raw) return { valid: false, reason: "DEADLINE_MISSING" };
  if (dateOnly.test(raw)) return { valid: true, instant: berlinStartOfNextDay(raw), sourceDay: raw, dateOnly: true };
  if (!explicitZone.test(raw)) return { valid: false, reason: "DEADLINE_TIMEZONE_AMBIGUOUS" };
  const instant = new Date(raw);
  if (Number.isNaN(instant.getTime())) return { valid: false, reason: "DEADLINE_INVALID" };
  return { valid: true, instant, sourceDay: berlinDay(instant), dateOnly: false };
}

function sourceDeadlineValues(normalized) {
  const values = [];
  const ted = normalized?.raw?.["deadline-receipt-tender-date-lot"];
  if (Array.isArray(ted)) values.push(...ted);
  const doeLots = normalized?.raw?.tender?.lots;
  if (Array.isArray(doeLots)) for (const lot of doeLots) {
    const value = lot?.tenderPeriod?.endDate ?? lot?.deadline ?? lot?.offerDeadline;
    if (value != null) values.push(value);
  }
  const normalizedLots = normalized?.lots;
  if (Array.isArray(normalizedLots)) for (const lot of normalizedLots) {
    const value = lot?.tenderPeriod?.endDate ?? lot?.deadline ?? lot?.offerDeadline;
    if (value != null) values.push(value);
  }
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

const sourceExplicitlyActive = (status) => /^(active|planned|planning|tender|open|reactivated|extended|cn-[a-z0-9-]+)$/i.test(String(status || "").trim());
const sourceExplicitlyInactive = (status) => /^(withdrawn|canceled|cancelled|terminated|unsuccessful|aufgehoben|zurückgezogen|complete|completed|closed|award)$/i.test(String(status || "").trim());

export function evaluateExpiryCandidate(row, now = new Date()) {
  if (row?.data_class !== "PUBLIC_REAL" || !PUBLIC_CLEANUP_SOURCES.includes(row?.source_code)) return { eligible: false, reason: "OUT_OF_SCOPE" };
  if (!row.offer_deadline) return { eligible: false, ambiguous: true, reason: "DEADLINE_MISSING" };
  if (!row.normalized_data || !row.normalized_data.raw) return { eligible: false, ambiguous: true, reason: "SOURCE_DECISION_DATA_MISSING" };
  const source = bindingDeadline(row.normalized_data.offerDeadline);
  if (!source.valid) return { eligible: false, ambiguous: true, reason: source.reason };
  const stored = new Date(row.offer_deadline);
  if (Number.isNaN(stored.getTime())) return { eligible: false, ambiguous: true, reason: "STORED_DEADLINE_INVALID" };
  const deadlineMatches = source.dateOnly
    ? Math.abs(stored.getTime() - source.instant.getTime()) < 1000 || berlinDay(stored) === source.sourceDay
    : Math.abs(stored.getTime() - source.instant.getTime()) < 1000;
  if (!deadlineMatches) return { eligible: false, ambiguous: true, reason: "DEADLINE_CONTRADICTION" };
  if (!row.source_timestamp || !row.version_source_timestamp || new Date(row.source_timestamp).getTime() !== new Date(row.version_source_timestamp).getTime()) {
    return { eligible: false, ambiguous: true, reason: "SOURCE_VERSION_CONTRADICTION" };
  }
  if (source.instant.getTime() > now.getTime()) return { eligible: false, reason: "DEADLINE_ACTIVE" };
  const lotValues = sourceDeadlineValues(row.normalized_data);
  for (const value of lotValues) {
    const deadline = bindingDeadline(value);
    if (!deadline.valid) return { eligible: false, ambiguous: true, reason: "LOT_DEADLINE_AMBIGUOUS" };
    if (deadline.instant.getTime() > now.getTime()) return { eligible: false, reason: "ACTIVE_LOT_DEADLINE" };
  }
  if (sourceExplicitlyActive(row.normalized_data.sourceStatus)) {
    return { eligible: false, ambiguous: true, reason: "SOURCE_STATUS_ACTIVE_CONTRADICTION" };
  }
  if (!sourceExplicitlyInactive(row.normalized_data.sourceStatus)) {
    return { eligible: false, ambiguous: true, reason: "SOURCE_STATUS_NOT_CONFIRMED_INACTIVE" };
  }
  return { eligible: true, reason: "SOURCE_CONFIRMED_INACTIVE_AFTER_DEADLINE", effectiveDeadline: source.instant.toISOString() };
}

export function tombstoneImportDecision(tombstone, normalized, now = new Date()) {
  if (!tombstone || tombstone.tombstone_status !== "DELETED") return { allow: true, reactivated: false };
  const deadline = bindingDeadline(normalized?.offerDeadline);
  const incomingUpdated = new Date(normalized?.sourceTimestamp || "");
  const priorUpdated = new Date(tombstone.source_updated_at || "");
  if (!deadline.valid || Number.isNaN(incomingUpdated.getTime()) || Number.isNaN(priorUpdated.getTime())) return { allow: false, reason: "TOMBSTONE_SOURCE_AMBIGUOUS" };
  if (incomingUpdated.getTime() <= priorUpdated.getTime()) return { allow: false, reason: "TOMBSTONE_SOURCE_NOT_NEWER" };
  if (deadline.instant.getTime() <= now.getTime()) return { allow: false, reason: "TOMBSTONE_STILL_EXPIRED" };
  if (sourceExplicitlyInactive(normalized?.sourceStatus)) return { allow: false, reason: "TOMBSTONE_SOURCE_INACTIVE" };
  if (!sourceExplicitlyActive(normalized?.sourceStatus)) return { allow: false, reason: "TOMBSTONE_REACTIVATION_NOT_CONFIRMED" };
  return { allow: true, reactivated: true, reason: "NEWER_UNAMBIGUOUS_DEADLINE_EXTENSION", deadline: deadline.instant.toISOString() };
}

const candidateSql = `SELECT t.*,
  version.normalized_data,version.source_timestamp version_source_timestamp,version.id version_id
FROM tender.tenders t
LEFT JOIN LATERAL(
  SELECT id,normalized_data,source_timestamp FROM tender.tender_versions
  WHERE tender_id=t.id ORDER BY version DESC,created_at DESC LIMIT 1
) version ON true
WHERE t.data_class='PUBLIC_REAL' AND t.source_code=ANY($1::text[]) AND t.offer_deadline IS NOT NULL AND t.offer_deadline<=$2
ORDER BY t.offer_deadline,t.id`;

const cleanupSizesSql = `SELECT
  (SELECT count(*)::int FROM tender.enrichment_versions enrichment JOIN tender.enrichment_documents document ON document.enrichment_version_id=enrichment.id WHERE enrichment.tender_id=$1) attachment_count,
  (SELECT coalesce(sum(coalesce(document.content_size,octet_length(document.content),0)),0)::bigint FROM tender.enrichment_versions enrichment JOIN tender.enrichment_documents document ON document.enrichment_version_id=enrichment.id WHERE enrichment.tender_id=$1) attachment_bytes,
  (SELECT coalesce(sum(pg_column_size(raw.raw_text)+coalesce(pg_column_size(raw.raw_json),0)),0)::bigint FROM tender.import_raw_payloads raw WHERE raw.source_code=$2 AND raw.external_id=$3) source_bytes`;

const protectedSql = `SELECT
  (t.company_id IS NOT NULL OR t.assigned_user_id IS NOT NULL
   OR EXISTS(SELECT 1 FROM tender.favorites x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.notes x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.tasks x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.reminders x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.decisions x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.calculations x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.calculation_user_inputs x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.calculation_input_snapshots x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.bid_packages x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.approval_requests x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.submission_contexts x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.required_documents x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.required_document_uploads x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.required_document_working_copies x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.signature_documents x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.generated_documents x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.document_access_registrations x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.external_action_releases x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.binding_action_releases x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.procedure_monitoring x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.portal_inbound_events x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.portal_login_continuations x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.portal_session_context_dispatches x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.final_preflight_contexts x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.management_outputs x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.documents x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.evaluations x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.upload_malware_scans x WHERE x.tender_id=t.id)
   OR EXISTS(SELECT 1 FROM tender.audit_events x WHERE x.tender_id=t.id)) protected
FROM tender.tenders t WHERE t.id=$1`;

async function databaseBytes(pool) {
  return Number((await pool.query("SELECT pg_database_size(current_database()) bytes")).rows[0].bytes);
}
function filesystemFreeBytes() {
  try { const value = statfsSync("/run/secrets/database_url"); return Number(value.bavail) * Number(value.bsize); } catch { return null; }
}

async function inspect(pool, now) {
  const rows = (await pool.query(candidateSql, [PUBLIC_CLEANUP_SOURCES, now])).rows;
  const missing = Number((await pool.query("SELECT count(*) n FROM tender.tenders WHERE data_class='PUBLIC_REAL' AND source_code=ANY($1::text[]) AND offer_deadline IS NULL", [PUBLIC_CLEANUP_SOURCES])).rows[0].n);
  const result = { checked: rows.length + missing, ambiguous: missing, candidates: [], protected: [], skipped: [], attachments: 0, attachmentBytes: 0, sourceBytes: 0, distribution: {} };
  for (const row of rows) {
    const decision = evaluateExpiryCandidate(row, now);
    if (!decision.eligible) {
      if (decision.ambiguous) result.ambiguous += 1;
      result.skipped.push({ sourceCode: row.source_code, externalId: row.external_id, reason: decision.reason, ambiguous: Boolean(decision.ambiguous) });
      continue;
    }
    const sizes = (await pool.query(cleanupSizesSql,[row.id,row.source_code,row.external_id])).rows[0];
    row.attachment_count=Number(sizes.attachment_count || 0);
    row.attachment_bytes=Number(sizes.attachment_bytes || 0);
    row.source_bytes=Number(sizes.source_bytes || 0);
    const protectedRecord = Boolean((await pool.query(protectedSql, [row.id])).rows[0]?.protected);
    const item = { ...row, decision, protected: protectedRecord };
    (protectedRecord ? result.protected : result.candidates).push(item);
    result.attachments += Number(row.attachment_count);
    result.attachmentBytes += Number(row.attachment_bytes);
    result.sourceBytes += Number(row.source_bytes);
    const key = `${row.source_code}:${berlinDay(new Date(row.offer_deadline))}`;
    result.distribution[key] = (result.distribution[key] || 0) + 1;
  }
  return result;
}

async function recordExpiryReviews(pool, report, now) {
  await pool.query(`INSERT INTO tender.tender_expiry_reviews(source_code,external_id,tender_id,reason_code,last_known_deadline,source_updated_at,first_seen_at,last_seen_at,review_status)
    SELECT source_code,external_id,id,'DEADLINE_MISSING',offer_deadline,source_timestamp,$2,$2,'OPEN'
    FROM tender.tenders
    WHERE data_class='PUBLIC_REAL' AND source_code=ANY($1::text[]) AND offer_deadline IS NULL
    ON CONFLICT(source_code,external_id) DO UPDATE SET tender_id=excluded.tender_id,reason_code=excluded.reason_code,last_known_deadline=excluded.last_known_deadline,source_updated_at=excluded.source_updated_at,last_seen_at=excluded.last_seen_at,review_status='OPEN',resolved_at=NULL
    WHERE tender.tender_expiry_reviews.tender_id IS DISTINCT FROM excluded.tender_id
       OR tender.tender_expiry_reviews.reason_code IS DISTINCT FROM excluded.reason_code
       OR tender.tender_expiry_reviews.last_known_deadline IS DISTINCT FROM excluded.last_known_deadline
       OR tender.tender_expiry_reviews.source_updated_at IS DISTINCT FROM excluded.source_updated_at
       OR tender.tender_expiry_reviews.review_status<>'OPEN'`, [PUBLIC_CLEANUP_SOURCES,now]);
  const ambiguous = report.skipped.filter((item) => item.ambiguous);
  for (let offset=0; offset<ambiguous.length; offset+=1000) {
    await pool.query(`INSERT INTO tender.tender_expiry_reviews(source_code,external_id,tender_id,reason_code,last_known_deadline,source_updated_at,first_seen_at,last_seen_at,review_status)
      SELECT item.source_code,item.external_id,tender.id,item.reason_code,tender.offer_deadline,tender.source_timestamp,$2,$2,'OPEN'
      FROM jsonb_to_recordset($1::jsonb) item(source_code text,external_id text,reason_code text)
      JOIN tender.tenders tender ON tender.source_code=item.source_code AND tender.external_id=item.external_id
      ON CONFLICT(source_code,external_id) DO UPDATE SET tender_id=excluded.tender_id,reason_code=excluded.reason_code,last_known_deadline=excluded.last_known_deadline,source_updated_at=excluded.source_updated_at,last_seen_at=excluded.last_seen_at,review_status='OPEN',resolved_at=NULL
      WHERE tender.tender_expiry_reviews.tender_id IS DISTINCT FROM excluded.tender_id
         OR tender.tender_expiry_reviews.reason_code IS DISTINCT FROM excluded.reason_code
         OR tender.tender_expiry_reviews.last_known_deadline IS DISTINCT FROM excluded.last_known_deadline
         OR tender.tender_expiry_reviews.source_updated_at IS DISTINCT FROM excluded.source_updated_at
         OR tender.tender_expiry_reviews.review_status<>'OPEN'`,
    [JSON.stringify(ambiguous.slice(offset,offset+1000).map((item)=>({source_code:item.sourceCode,external_id:item.externalId,reason_code:item.reason}))),now]);
  }
  await pool.query(`UPDATE tender.tender_expiry_reviews review SET review_status='RESOLVED',resolved_at=$2,last_seen_at=$2
    WHERE review.review_status='OPEN' AND EXISTS(
      SELECT 1 FROM tender.tenders tender WHERE tender.source_code=review.source_code AND tender.external_id=review.external_id
      AND (tender.data_class<>'PUBLIC_REAL' OR tender.source_code<>ALL($1::text[]) OR tender.offer_deadline>$2)
    )`, [PUBLIC_CLEANUP_SOURCES,now]);
  return Number((await pool.query("SELECT count(*) n FROM tender.tender_expiry_reviews WHERE review_status='OPEN'")).rows[0].n);
}

async function upsertTombstone(client, row) {
  await client.query(`INSERT INTO tender.tender_tombstones(source_code,external_id,last_known_deadline,deleted_at,deletion_reason,last_source_status,source_updated_at,tombstone_status)
    VALUES($1,$2,$3,now(),'SOURCE_CONFIRMED_INACTIVE_AFTER_DEADLINE',$4,$5,'DELETED')
    ON CONFLICT(source_code,external_id) DO UPDATE SET last_known_deadline=excluded.last_known_deadline,deleted_at=excluded.deleted_at,deletion_reason=excluded.deletion_reason,last_source_status=excluded.last_source_status,source_updated_at=GREATEST(tender.tender_tombstones.source_updated_at,excluded.source_updated_at),tombstone_status='DELETED',reactivated_at=NULL,reactivation_reason=NULL,reactivation_source_updated_at=NULL,updated_at=now()`,
  [row.source_code,row.external_id,row.offer_deadline,row.normalized_data?.sourceStatus || null,row.source_timestamp]);
}

async function deleteSourcePayloads(client, row) {
  const deleted = await client.query(`DELETE FROM tender.import_raw_payloads
    WHERE source_code=$1 AND external_id=$2 AND processing_status IN ('IMPORTED','DUPLICATE','CAPTURED')
    RETURNING pg_column_size(raw_text)+coalesce(pg_column_size(raw_json),0) bytes,source_page_id`, [row.source_code,row.external_id]);
  const pageIds = [...new Set(deleted.rows.map((item) => item.source_page_id).filter(Boolean))];
  if (pageIds.length) await client.query(`DELETE FROM tender.import_source_pages page WHERE id=ANY($1::uuid[])
    AND NOT EXISTS(SELECT 1 FROM tender.import_raw_payloads raw WHERE raw.source_page_id=page.id)`, [pageIds]);
  return deleted.rows.reduce((sum,item) => sum + Number(item.bytes || 0),0);
}

async function deleteEnrichment(client, tenderId) {
  const documents = (await client.query(`SELECT document.id,document.payload_sha256,coalesce(document.content_size,octet_length(document.content),0)::bigint bytes
    FROM tender.enrichment_documents document JOIN tender.enrichment_versions version ON version.id=document.enrichment_version_id WHERE version.tender_id=$1`, [tenderId])).rows;
  const ids = documents.map((item) => item.id), hashes = documents.map((item) => item.payload_sha256).filter(Boolean);
  if (ids.length) await client.query("DELETE FROM tender.enrichment_document_blobs WHERE enrichment_document_id=ANY($1::uuid[])", [ids]);
  await client.query("DELETE FROM tender.enrichment_documents WHERE enrichment_version_id IN(SELECT id FROM tender.enrichment_versions WHERE tender_id=$1)", [tenderId]);
  await client.query("DELETE FROM tender.enrichment_fields WHERE enrichment_version_id IN(SELECT id FROM tender.enrichment_versions WHERE tender_id=$1)", [tenderId]);
  await client.query("DELETE FROM tender.enrichment_lots WHERE enrichment_version_id IN(SELECT id FROM tender.enrichment_versions WHERE tender_id=$1)", [tenderId]);
  await client.query("DELETE FROM tender.enrichment_versions WHERE tender_id=$1", [tenderId]);
  if (hashes.length) await client.query(`DELETE FROM tender.document_blobs blob WHERE payload_sha256=ANY($1::char(64)[])
    AND NOT EXISTS(SELECT 1 FROM tender.enrichment_document_blobs link WHERE link.payload_sha256=blob.payload_sha256)
    AND NOT EXISTS(SELECT 1 FROM tender.generated_documents generated WHERE generated.sha256=blob.payload_sha256)`, [hashes]);
  return { count: documents.length, bytes: documents.reduce((sum,item) => sum + Number(item.bytes || 0),0) };
}

async function deleteDerivedTender(client, row) {
  await client.query("DELETE FROM tender.autopilot_dlq_classifications WHERE tender_id=$1", [row.id]);
  await client.query("DELETE FROM tender.autopilot_queue WHERE tender_id=$1", [row.id]);
  await client.query("DELETE FROM tender.autopilot_results WHERE tender_id=$1", [row.id]);
  await client.query("DELETE FROM tender.canonical_read_snapshots WHERE tender_id=$1", [row.id]);
  await client.query("DELETE FROM tender.region_evaluations WHERE tender_id=$1", [row.id]);
  await client.query("DELETE FROM tender.inbox_pipeline_items WHERE tender_id=$1", [row.id]);
  await client.query("DELETE FROM tender.service_relevance_evaluations WHERE tender_id=$1", [row.id]);
  await client.query("DELETE FROM tender.management_inbox WHERE tender_id=$1", [row.id]);
  await client.query("DELETE FROM tender.board_briefs WHERE tender_id=$1", [row.id]);
  const attachment = await deleteEnrichment(client,row.id);
  await client.query("DELETE FROM tender.source_references WHERE tender_id=$1", [row.id]);
  await client.query("DELETE FROM tender.tender_versions WHERE tender_id=$1", [row.id]);
  await client.query("DELETE FROM tender.lots WHERE tender_id=$1", [row.id]);
  await client.query("DELETE FROM tender.duplicate_links WHERE left_id=$1 OR right_id=$1", [row.id]);
  await client.query("DELETE FROM tender.tenders WHERE id=$1", [row.id]);
  return attachment;
}

async function processBatch(pool, runId, batch) {
  const client = await pool.connect(), stats = { deleted: 0, protected: 0, tombstones: 0, attachments: 0, attachmentBytes: 0, sourceBytes: 0, errors: 0 };
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("SET LOCAL statement_timeout='2min'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('wb-tender-expiry-cleanup'))");
    for (const row of batch) {
      await client.query("SAVEPOINT cleanup_item");
      try {
        const current = (await client.query("SELECT offer_deadline,source_timestamp,raw_sha256,source_lifecycle_status FROM tender.tenders WHERE id=$1 FOR UPDATE", [row.id])).rows[0];
        if (!current || new Date(current.offer_deadline).getTime() !== new Date(row.offer_deadline).getTime() || new Date(current.source_timestamp).getTime() !== new Date(row.source_timestamp).getTime() || current.raw_sha256 !== row.raw_sha256) {
          throw Object.assign(new Error("candidate changed after synchronization"), { code: "CANDIDATE_CHANGED" });
        }
        await upsertTombstone(client,row);
        stats.tombstones += 1;
        const sourceBytes = await deleteSourcePayloads(client,row);
        stats.sourceBytes += sourceBytes;
        let attachment = { count: 0, bytes: 0 }, action;
        if (row.protected) {
          // Keep relational enrichment/document evidence when any customer or
          // work-product reference exists. It may be reached indirectly through
          // calculations or workflow snapshots even when no direct FK exists.
          // Public visibility and raw source payload removal are still immediate.
          await client.query("UPDATE tender.tender_versions SET normalized_data=jsonb_build_object('sourceCode',$2::text,'externalId',$3::text,'offerDeadline',$4::timestamptz,'tombstoned',true) WHERE tender_id=$1", [row.id,row.source_code,row.external_id,row.offer_deadline]);
          await client.query(`UPDATE tender.tenders SET source_lifecycle_status='TOMBSTONED',archived_at=coalesce(archived_at,now()),buyer='[removed]',title='[expired public tender removed]',description=NULL,cpv_codes='{}',regions='{}',source_url='',updated_at=now() WHERE id=$1`, [row.id]);
          stats.protected += 1; action = "PROTECTED_TOMBSTONE";
        } else {
          attachment = await deleteDerivedTender(client,row);
          stats.deleted += 1; action = "DELETED";
        }
        stats.attachments += attachment.count; stats.attachmentBytes += attachment.bytes;
        await client.query(`INSERT INTO tender.tender_cleanup_items(cleanup_run_id,source_code,external_id,action,reason_code,attachment_count,attachment_bytes,source_bytes)
          VALUES($1,$2,$3,$4,'SOURCE_CONFIRMED_INACTIVE_AFTER_DEADLINE',$5,$6,$7) ON CONFLICT DO NOTHING`, [runId,row.source_code,row.external_id,action,attachment.count,attachment.bytes,sourceBytes]);
        await client.query("RELEASE SAVEPOINT cleanup_item");
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT cleanup_item");
        stats.errors += 1;
        await client.query(`INSERT INTO tender.tender_cleanup_items(cleanup_run_id,source_code,external_id,action,reason_code)
          VALUES($1,$2,$3,'ERROR',$4) ON CONFLICT DO NOTHING`, [runId,row.source_code,row.external_id,String(error.code || "CLEANUP_ITEM_FAILED").slice(0,80)]);
        await client.query("RELEASE SAVEPOINT cleanup_item");
      }
    }
    await client.query("COMMIT");
    return stats;
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}

const vacuumTables = ["tenders","tender_versions","service_relevance_evaluations","import_raw_payloads","import_source_pages","enrichment_versions","enrichment_documents","enrichment_fields","enrichment_lots","document_blobs"];
async function vacuumAnalyze(pool) {
  const client=await pool.connect();
  try {
    await client.query("SET statement_timeout='30min'");
    await client.query("SET max_parallel_maintenance_workers=0");
    for (const table of vacuumTables) await client.query(`VACUUM (ANALYZE, SKIP_LOCKED, PARALLEL 0) tender.${table}`);
  } finally {
    await client.query("RESET ALL").catch(()=>{});
    client.release();
  }
}

export async function cleanupDryRun(pool, { now = new Date() } = {}) {
  const report = await inspect(pool,now);
  return {
    dryRun: true, writeAccess: false, cleanupVersion: CLEANUP_VERSION,
    checked: report.checked, candidates: report.candidates.length + report.protected.length,
    deletable: report.candidates.length, protected: report.protected.length, ambiguous: report.ambiguous,
    attachments: report.attachments, attachmentBytes: report.attachmentBytes,
    sourceBytes: report.sourceBytes, estimatedReclaimableBytes: report.attachmentBytes + report.sourceBytes,
    distribution: report.distribution,
  };
}

export async function runTenderCleanup(pool, { syncSucceeded, syncRunIds = [], batchSize = DEFAULT_CLEANUP_BATCH_SIZE, now = new Date(), runKind = "SCHEDULED", vacuum = true } = {}) {
  if (!syncSucceeded) {
    const skipped = await pool.query(`INSERT INTO tender.tender_cleanup_runs(run_kind,status,sync_run_ids,finished_at,error_count,error_code,metrics)
      VALUES($1,'SKIPPED_SYNC_FAILURE',$2,now(),1,'PREVIOUS_SYNCHRONIZATION_NOT_SUCCESSFUL',$3::jsonb) RETURNING id`, [runKind,syncRunIds,JSON.stringify({cleanupVersion:CLEANUP_VERSION})]);
    return { passed: false, skipped: true, runId: skipped.rows[0].id, reason: "PREVIOUS_SYNCHRONIZATION_NOT_SUCCESSFUL" };
  }
  const boundedBatch = Math.max(1,Math.min(1000,Number(batchSize) || DEFAULT_CLEANUP_BATCH_SIZE));
  const started = Date.now(), dbBefore = await databaseBytes(pool), freeBefore = filesystemFreeBytes();
  const walBefore = (await pool.query("SELECT pg_current_wal_lsn() lsn")).rows[0].lsn;
  const run = (await pool.query(`INSERT INTO tender.tender_cleanup_runs(run_kind,status,sync_run_ids,database_bytes_before,filesystem_free_bytes_before,metrics)
    VALUES($1,'RUNNING',$2,$3,$4,$5::jsonb) RETURNING id`, [runKind,syncRunIds,dbBefore,freeBefore,JSON.stringify({ cleanupVersion:CLEANUP_VERSION,batchSize:boundedBatch })])).rows[0];
  try {
    const report = await inspect(pool,now), reviewCount = await recordExpiryReviews(pool,report,now), work = [...report.candidates,...report.protected], total = { deleted:0,protected:0,tombstones:0,attachments:0,attachmentBytes:0,sourceBytes:0,errors:0 };
    for (let offset=0; offset<work.length; offset+=boundedBatch) {
      const result = await processBatch(pool,run.id,work.slice(offset,offset+boundedBatch));
      for (const key of Object.keys(total)) total[key] += result[key];
    }
    await pool.query(`UPDATE tender.tender_cleanup_runs SET checked_count=$2,deleted_count=$3,tombstone_count=$4,protected_count=$5,ambiguous_count=$6,deleted_file_count=$7,deleted_file_bytes=$8,deleted_source_bytes=$9,error_count=$10,metrics=metrics||$11::jsonb WHERE id=$1`,
      [run.id,report.checked,total.deleted,total.tombstones,total.protected,report.ambiguous,total.attachments,total.attachmentBytes,total.sourceBytes,total.errors,JSON.stringify({distribution:report.distribution,estimatedReclaimableBytes:report.attachmentBytes+report.sourceBytes,reviewGroupCount:reviewCount})]);
    if (vacuum && (total.deleted || total.protected)) await vacuumAnalyze(pool);
    const dbAfter = await databaseBytes(pool), freeAfter = filesystemFreeBytes();
    const walBytes = Number((await pool.query("SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),$1) bytes", [walBefore])).rows[0].bytes);
    const status = total.errors ? "FAILED" : "SUCCESS";
    await pool.query(`UPDATE tender.tender_cleanup_runs SET status=$2,finished_at=now(),checked_count=$3,deleted_count=$4,tombstone_count=$5,protected_count=$6,ambiguous_count=$7,deleted_file_count=$8,deleted_file_bytes=$9,deleted_source_bytes=$10,database_bytes_after=$11,filesystem_free_bytes_after=$12,wal_bytes=$13,duration_ms=$14,error_count=$15,error_code=$16,metrics=metrics||$17::jsonb WHERE id=$1`,
      [run.id,status,report.checked,total.deleted,total.tombstones,total.protected,report.ambiguous,total.attachments,total.attachmentBytes,total.sourceBytes,dbAfter,freeAfter,walBytes,Date.now()-started,total.errors,total.errors?"CLEANUP_ITEM_FAILED":null,JSON.stringify({distribution:report.distribution,estimatedReclaimableBytes:report.attachmentBytes+report.sourceBytes,reviewGroupCount:reviewCount})]);
    return { passed:!total.errors,runId:run.id,status,checked:report.checked,deleted:total.deleted,tombstones:total.tombstones,protected:total.protected,ambiguous:report.ambiguous,reviewGroupCount:reviewCount,attachmentsDeleted:total.attachments,attachmentBytesDeleted:total.attachmentBytes,sourceBytesDeleted:total.sourceBytes,databaseBytesBefore:dbBefore,databaseBytesAfter:dbAfter,filesystemFreeBytesBefore:freeBefore,filesystemFreeBytesAfter:freeAfter,walBytes,durationMs:Date.now()-started,errors:total.errors };
  } catch (error) {
    await pool.query("UPDATE tender.tender_cleanup_runs SET status='FAILED',finished_at=now(),duration_ms=$2,error_count=1,error_code=$3 WHERE id=$1", [run.id,Date.now()-started,String(error.code || "CLEANUP_FAILED").slice(0,80)]).catch(() => {});
    throw error;
  }
}
