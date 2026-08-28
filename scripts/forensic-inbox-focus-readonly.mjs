import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const connectionString = process.env.DATABASE_URL || readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim();
const pool = new pg.Pool({ connectionString, max: 1, options: "-c default_transaction_read_only=on -c statement_timeout=30000" });
const anon = (value) => value ? createHash("sha256").update(String(value)).digest("hex").slice(0, 12) : null;
const print = (name, rows) => console.log(JSON.stringify({ name, rows }, null, 2));

try {
  print("stage_status", (await pool.query(`SELECT
    (SELECT max(finished_at) FROM tender.scheduler_runs WHERE status='SUCCESS') source_sync,
    (SELECT max(created_at) FROM tender.service_relevance_evaluations) classification_and_matching,
    (SELECT max(created_at) FROM tender.region_evaluations) regionalization,
    (SELECT max(coalesce(retrieved_at,created_at)) FROM tender.enrichment_documents) document_processing,
    (SELECT max(created_at) FROM tender.management_inbox) inbox_materialization,
    to_regclass('tender.inbox_pipeline_runs') inbox_pipeline_audit_relation`)).rows);
  print("counts", (await pool.query(`SELECT
    (SELECT count(*) FROM tender.tenders WHERE data_class='PUBLIC_REAL') public_tenders,
    (SELECT count(*) FROM tender.tenders WHERE data_class='PUBLIC_REAL' AND created_at>'2026-08-05T07:22:25.910786Z') imported_after_last_inbox,
    (SELECT count(*) FROM tender.current_service_relevance r JOIN tender.tenders t ON t.id=r.tender_id WHERE t.created_at>'2026-08-05T07:22:25.910786Z' AND r.service_line='security' AND r.relevance_status='RELEVANT' AND r.service_scope_gate='PASSED' AND r.primary_company) new_security_matches,
    (SELECT count(*) FROM tender.region_evaluations e JOIN tender.tenders t ON t.id=e.tender_id WHERE t.created_at>'2026-08-05T07:22:25.910786Z') new_region_rows,
    (SELECT count(*) FROM tender.management_inbox i JOIN tender.tenders t ON t.id=i.tender_id WHERE t.created_at>'2026-08-05T07:22:25.910786Z') new_inbox_rows`)).rows);
  const configs = (await pool.query(`SELECT a.company_id,a.service_line,a.parameter_key,c.new_value,v.id version_id,v.version_no
    FROM tender.configuration_active_parameters a JOIN tender.configuration_changes c ON c.id=a.change_id JOIN tender.configuration_versions v ON v.id=c.version_id AND v.status='ACTIVE'
    WHERE a.parameter_key IN('A08','A09','A10','B07') AND a.company_id IN(SELECT DISTINCT company_id FROM tender.current_service_relevance WHERE service_line='security')
    ORDER BY a.company_id,a.service_line,a.parameter_key,v.version_no DESC`)).rows;
  print("security_region_configuration", configs.map((row) => ({ ...row, company_id: anon(row.company_id), version_id: anon(row.version_id) })));
  print("existing_security_region_examples", (await pool.query(`SELECT e.classification,e.detected_states,e.detected_nuts,e.parameter_key,e.configuration_version_no,e.created_at,t.regions
    FROM tender.region_evaluations e JOIN tender.tenders t ON t.id=e.tender_id JOIN tender.current_service_relevance r ON r.tender_id=t.id AND r.company_id=e.company_id AND r.service_line='security'
    WHERE e.lot_id IS NULL ORDER BY e.created_at DESC LIMIT 12`)).rows);
  const rows = (await pool.query(`WITH targets AS MATERIALIZED(
      SELECT t.*,r.company_id matched_company_id,r.service_line,r.relevance_status,r.service_scope_gate,r.primary_company,r.reason
      FROM tender.tenders t JOIN tender.current_service_relevance r ON r.tender_id=t.id AND r.service_line='security' AND r.relevance_status='RELEVANT' AND r.service_scope_gate='PASSED' AND r.primary_company
      WHERE t.data_class='PUBLIC_REAL' AND t.created_at>'2026-08-05T07:22:25.910786Z' ORDER BY t.created_at DESC LIMIT 20
    ) SELECT t.id,t.external_id,t.source_code,coalesce(raw_import.retrieved_at,t.created_at) import_time,t.publication_date,t.offer_deadline,t.source_lifecycle_status,t.classification_status,t.classification_confidence,t.assigned_service_line,t.cpv_codes,t.regions,
      latest_version.normalized_data->'locations' locations,r.matched_company_id company_id,r.service_line,r.relevance_status,r.service_scope_gate,r.primary_company,r.reason,
      coalesce(docs.document_count,0) document_count,docs.document_statuses,
      EXISTS(SELECT 1 FROM tender.region_evaluations e WHERE e.tender_id=t.id AND e.company_id=r.matched_company_id AND e.lot_id IS NULL) has_region,
      EXISTS(SELECT 1 FROM tender.management_inbox i WHERE i.tender_id=t.id AND i.company_id=r.matched_company_id) has_inbox,
      EXISTS(SELECT 1 FROM tender.tender_tombstones tomb WHERE tomb.source_code=t.source_code AND tomb.external_id=t.external_id AND tomb.tombstone_status='DELETED') tombstoned,
      raw_import.processing_status,raw_import.replay_status
    FROM targets t
    CROSS JOIN LATERAL(SELECT t.matched_company_id,t.service_line,t.relevance_status,t.service_scope_gate,t.primary_company,t.reason)r
    LEFT JOIN LATERAL(SELECT retrieved_at,processing_status,replay_status FROM tender.import_raw_payloads p WHERE p.source_code=t.source_code AND p.external_id=t.external_id ORDER BY retrieved_at DESC LIMIT 1)raw_import ON true
    LEFT JOIN LATERAL(SELECT count(*) document_count,array_agg(DISTINCT coalesce(d.resolution_status,d.fetch_status)) document_statuses FROM tender.enrichment_versions e JOIN tender.enrichment_documents d ON d.enrichment_version_id=e.id WHERE e.tender_id=t.id AND e.historical=false)docs ON true
    LEFT JOIN LATERAL(SELECT normalized_data FROM tender.tender_versions v WHERE v.tender_id=t.id ORDER BY version DESC LIMIT 1)latest_version ON true
    ORDER BY t.created_at DESC`)).rows;
  print("security_candidates", rows.map((row) => ({ ...row, id: anon(row.id), external_id: anon(row.external_id), company_id: anon(row.company_id) })));
} finally { await pool.end(); }
