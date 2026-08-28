import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const connectionString = process.env.DATABASE_URL || readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim();
const pool = new pg.Pool({ connectionString, max: 1, options: "-c default_transaction_read_only=on -c statement_timeout=30000" });
const query = async (name, sql, values = []) => {
  const result = await pool.query(sql, values);
  console.log(JSON.stringify({ name, rows: result.rows }, null, 2));
};
const anonymize = (value) => value ? createHash("sha256").update(String(value)).digest("hex").slice(0, 12) : null;

try {
  await query("relations", `SELECT table_name,table_type FROM information_schema.tables WHERE table_schema='tender' AND table_name IN ('tenders','tender_versions','service_relevance_evaluations','current_service_relevance','region_evaluations','management_inbox','inbox_pipeline_runs','inbox_pipeline_items','enrichment_versions','enrichment_documents','scheduler_runs','import_runs','import_raw_payloads','tender_tombstones') ORDER BY table_name`);
  await query("columns", `SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='tender' AND table_name IN ('tenders','service_relevance_evaluations','region_evaluations','management_inbox','enrichment_documents','scheduler_runs','import_runs','inbox_pipeline_runs','inbox_pipeline_items') ORDER BY table_name,ordinal_position`);
  await query("latest_runs", `SELECT 'scheduler' kind,source_code,status,started_at,finished_at,error_code,read_count,new_count,updated_count,duplicate_count FROM tender.scheduler_runs ORDER BY started_at DESC LIMIT 12`);
  await query("stage_last_success", `SELECT
    (SELECT max(finished_at) FROM tender.scheduler_runs WHERE status='SUCCESS') source_sync,
    (SELECT max(created_at) FROM tender.service_relevance_evaluations) classification,
    (SELECT max(created_at) FROM tender.region_evaluations) regionalization,
    (SELECT max(coalesce(retrieved_at,created_at)) FROM tender.enrichment_documents) document_processing,
    (SELECT max(created_at) FROM tender.service_relevance_evaluations WHERE relevance_status='RELEVANT') matching,
    (SELECT max(created_at) FROM tender.management_inbox) inbox_materialization`);
  await query("counts", `SELECT
    (SELECT count(*) FROM tender.tenders WHERE data_class='PUBLIC_REAL') public_tenders,
    (SELECT count(*) FROM tender.tenders WHERE data_class='PUBLIC_REAL' AND created_at>='2026-08-18T00:00:00Z') new_since_aug18,
    (SELECT count(*) FROM tender.current_service_relevance WHERE service_line='security' AND relevance_status='RELEVANT') relevant_security,
    (SELECT count(*) FROM tender.region_evaluations) region_evaluations,
    (SELECT count(*) FROM tender.management_inbox) inbox_rows,
    to_regclass('tender.inbox_pipeline_runs') inbox_pipeline_runs_relation`);
  await query("relevance_shape", `SELECT to_jsonb(r) row FROM tender.current_service_relevance r WHERE r.service_line='security' LIMIT 1`);
  const candidates = (await pool.query(`WITH latest_region AS(
      SELECT DISTINCT ON(tender_id,company_id) * FROM tender.region_evaluations WHERE lot_id IS NULL ORDER BY tender_id,company_id,evaluation_version DESC
    ), docs AS(
      SELECT e.tender_id,count(*) document_count,array_agg(DISTINCT coalesce(d.resolution_status,d.fetch_status)) document_statuses,max(coalesce(d.retrieved_at,d.created_at)) document_last_attempt
      FROM tender.enrichment_versions e JOIN tender.enrichment_documents d ON d.enrichment_version_id=e.id WHERE e.historical=false GROUP BY e.tender_id
    ), inbox AS(
      SELECT DISTINCT ON(tender_id,company_id) tender_id,company_id,id inbox_id,workflow_status,created_at inbox_created_at FROM tender.management_inbox ORDER BY tender_id,company_id,created_at DESC
    ), raw_import AS(
      SELECT DISTINCT ON(source_code,external_id) source_code,external_id,retrieved_at,processing_status,replay_status,import_run_id FROM tender.import_raw_payloads ORDER BY source_code,external_id,retrieved_at DESC
    )
    SELECT t.id,t.external_id,t.source_code,coalesce(raw_import.retrieved_at,t.created_at) import_time,t.created_at,t.publication_date,t.offer_deadline,t.source_lifecycle_status,t.classification_status,t.classification_confidence,t.assigned_service_line,t.cpv_codes,t.regions,
      r.company_id,r.service_line,r.relevance_status,r.service_scope_gate,r.primary_company,r.reason relevance_reason,
      lr.classification region_classification,lr.detected_states,lr.detected_nuts,lr.matching_status region_matching_status,lr.explanation region_explanation,
      coalesce(docs.document_count,0) document_count,docs.document_statuses,docs.document_last_attempt,
      inbox.inbox_id,inbox.workflow_status,inbox.inbox_created_at,
      raw_import.processing_status raw_processing_status,raw_import.replay_status
    FROM tender.tenders t
    JOIN tender.current_service_relevance r ON r.tender_id=t.id AND r.service_line='security' AND r.relevance_status='RELEVANT' AND r.service_scope_gate='PASSED'
    LEFT JOIN latest_region lr ON lr.tender_id=t.id AND lr.company_id=r.company_id
    LEFT JOIN docs ON docs.tender_id=t.id LEFT JOIN inbox ON inbox.tender_id=t.id AND inbox.company_id=r.company_id
    LEFT JOIN raw_import ON raw_import.source_code=t.source_code AND raw_import.external_id=t.external_id
    WHERE t.data_class='PUBLIC_REAL' AND t.created_at>='2026-08-18T00:00:00Z'
    ORDER BY t.created_at DESC,t.id LIMIT 30`)).rows;
  console.log(JSON.stringify({ name: "security_candidates", rows: candidates.map((row) => ({ ...row, external_id: anonymize(row.external_id), id: anonymize(row.id), company_id: anonymize(row.company_id), inbox_id: anonymize(row.inbox_id) })) }, null, 2));
} finally {
  await pool.end();
}
