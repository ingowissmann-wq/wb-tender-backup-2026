import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import pg from "pg";

const connectionString=process.env.DATABASE_URL||readFileSync(process.env.DATABASE_URL_FILE,"utf8").trim();
const pool=new pg.Pool({connectionString,max:1,options:"-c default_transaction_read_only=on -c statement_timeout=30000"});
const anon=value=>value?createHash("sha256").update(String(value)).digest("hex").slice(0,12):null;
const print=(name,rows)=>console.log(JSON.stringify({name,rows},null,2));

try{
  print("integrity",(await pool.query(`SELECT
    (SELECT count(*) FROM tender.tenders) tenders,
    (SELECT count(*) FROM tender.tenders WHERE data_class='PUBLIC_REAL') public_tenders,
    (SELECT count(*) FROM tender.management_inbox) inbox_total,
    (SELECT count(DISTINCT event_fingerprint) FROM tender.management_inbox) inbox_unique_fingerprints,
    (SELECT count(*) FROM tender.management_inbox WHERE created_at<'2026-08-19T05:26:43.851912Z' AND updated_at>='2026-08-19T05:26:43.851912Z') preexisting_inbox_rows_changed,
    (SELECT count(*) FROM tender.region_evaluations WHERE source_data->>'pipelineVersion'='wb-daily-inbox-pipeline/1.0.0') pipeline_regions,
    (SELECT count(*) FROM tender.inbox_pipeline_items) pipeline_items,
    (SELECT count(*) FROM tender.inbox_pipeline_items WHERE document_status='NOT_DISCOVERED_IN_SOURCE_SYNC') documents_statused_not_discovered,
    (SELECT count(*) FROM tender.inbox_pipeline_items WHERE document_status LIKE '%FAILED%') document_failures,
    (SELECT count(*) FROM tender.inbox_pipeline_items item JOIN tender.tenders t ON t.id=item.tender_id WHERE t.source_lifecycle_status<>'ACTIVE' OR (t.offer_deadline IS NOT NULL AND t.offer_deadline<=now())) invalid_lifecycle,
    (SELECT count(*) FROM tender.inbox_pipeline_items item JOIN tender.tenders t ON t.id=item.tender_id JOIN tender.tender_tombstones tomb ON tomb.source_code=t.source_code AND tomb.external_id=t.external_id AND tomb.tombstone_status='DELETED') tombstoned_in_pipeline`)).rows);
  print("pipeline_runs",(await pool.query(`SELECT run_kind,status,cutoff_at,started_at,finished_at,checked_count,matched_count,inbox_created_count,region_created_count,skipped_count,error_count,error_code,metadata FROM tender.inbox_pipeline_runs ORDER BY started_at`)).rows);
  print("security_distribution",(await pool.query(`SELECT e.classification,count(*) count FROM tender.region_evaluations e JOIN tender.management_inbox i ON i.id=e.inbox_id AND i.service_line='security' WHERE e.lot_id IS NULL AND e.source_data->>'pipelineVersion'='wb-daily-inbox-pipeline/1.0.0' GROUP BY e.classification ORDER BY e.classification`)).rows);
  const rows=(await pool.query(`WITH chosen AS MATERIALIZED(
      (SELECT e.tender_id,e.company_id FROM tender.region_evaluations e JOIN tender.management_inbox i ON i.id=e.inbox_id AND i.service_line='security' JOIN tender.tenders t ON t.id=e.tender_id WHERE e.lot_id IS NULL AND e.source_data->>'pipelineVersion'='wb-daily-inbox-pipeline/1.0.0' AND e.classification='CORE_REGION' ORDER BY t.created_at DESC LIMIT 10)
      UNION ALL
      (SELECT e.tender_id,e.company_id FROM tender.region_evaluations e JOIN tender.management_inbox i ON i.id=e.inbox_id AND i.service_line='security' JOIN tender.tenders t ON t.id=e.tender_id WHERE e.lot_id IS NULL AND e.source_data->>'pipelineVersion'='wb-daily-inbox-pipeline/1.0.0' AND e.classification='OUTSIDE_CORE_REGION' ORDER BY t.created_at DESC LIMIT 5)
    ), latest_region AS(SELECT DISTINCT ON(e.tender_id,e.company_id) e.* FROM tender.region_evaluations e JOIN chosen c ON c.tender_id=e.tender_id AND c.company_id=e.company_id WHERE e.lot_id IS NULL ORDER BY e.tender_id,e.company_id,e.evaluation_version DESC)
    SELECT t.id,t.external_id,t.source_code,raw.retrieved_at import_time,t.publication_date,t.offer_deadline,t.source_lifecycle_status,t.classification_status,t.classification_confidence,t.assigned_service_line,t.cpv_codes,t.regions,v.normalized_data->'locations' locations,
      r.company_id,r.service_line,r.relevance_status,r.service_scope_gate,r.primary_company,r.reason classification_reason,
      e.classification region_classification,e.detected_states,e.detected_nuts,e.matching_status,e.explanation region_explanation,
      item.document_status,item.matching_status,item.inbox_status,item.exclusion_reason,
      inbox.workflow_status,inbox.decision inbox_decision,inbox.created_at inbox_created_at,
      raw.processing_status raw_status,raw.replay_status,
      (t.data_class='PUBLIC_REAL' AND t.source_lifecycle_status='ACTIVE' AND r.relevance_status IN('RELEVANT','POTENTIALLY_RELEVANT') AND r.primary_company) management_api_base_visible
    FROM chosen c JOIN tender.tenders t ON t.id=c.tender_id
    JOIN LATERAL(SELECT * FROM tender.service_relevance_evaluations x WHERE x.tender_id=t.id AND x.company_id=c.company_id ORDER BY x.evaluation_version DESC LIMIT 1)r ON true
    JOIN latest_region e ON e.tender_id=t.id AND e.company_id=c.company_id
    JOIN LATERAL(SELECT * FROM tender.inbox_pipeline_items x WHERE x.tender_id=t.id AND x.company_id=c.company_id ORDER BY x.created_at DESC LIMIT 1)item ON true
    JOIN LATERAL(SELECT * FROM tender.management_inbox x WHERE x.tender_id=t.id AND x.company_id=c.company_id ORDER BY x.created_at DESC LIMIT 1)inbox ON true
    LEFT JOIN LATERAL(SELECT retrieved_at,processing_status,replay_status FROM tender.import_raw_payloads x WHERE x.source_code=t.source_code AND x.external_id=t.external_id ORDER BY retrieved_at DESC LIMIT 1)raw ON true
    LEFT JOIN LATERAL(SELECT normalized_data FROM tender.tender_versions x WHERE x.tender_id=t.id ORDER BY version DESC LIMIT 1)v ON true
    ORDER BY (e.classification='CORE_REGION') DESC,t.created_at DESC`)).rows;
  print("security_end_to_end",rows.map(row=>({...row,id:anon(row.id),external_id:anon(row.external_id),company_id:anon(row.company_id)})));
}finally{await pool.end()}
