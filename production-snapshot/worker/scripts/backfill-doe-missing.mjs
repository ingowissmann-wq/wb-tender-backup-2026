import pg from "pg";
import { readFileSync } from "node:fs";
import { parseDoe } from "../platform/enrichment-core.mjs";

const VERSION = "full-enrichment-1.1";
const pool = new pg.Pool({ connectionString: readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim() });
const json = (value) => JSON.stringify(value ?? null);
const runId = (await pool.query("INSERT INTO tender.enrichment_runs(kind,status,mapper_version,parser_version) VALUES('DOE_PUBLIC_API_RECOVERY','RUNNING',$1,$1) RETURNING id", [VERSION])).rows[0].id;
const stats = { total: 0, enriched: 0, failed: 0 };

try {
  const tenders = (await pool.query("SELECT t.* FROM tender.tenders t WHERE source_code='DOE' AND NOT EXISTS(SELECT 1 FROM tender.enrichment_versions e WHERE e.tender_id=t.id AND e.parser_version=$1)", [VERSION])).rows;
  for (const tender of tenders) {
    stats.total++;
    try {
      const response = await fetch(tender.source_url, { headers: { "user-agent": "WB-Tender-Enrichment/1.1" } });
      if (!response.ok) throw new Error(`http_${response.status}`);
      const raw = await response.json();
      const result = parseDoe(raw, { url: tender.source_url });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const version = Number((await client.query("SELECT coalesce(max(version),0)+1 v FROM tender.enrichment_versions WHERE tender_id=$1", [tender.id])).rows[0].v);
        const enrichment = (await client.query(`INSERT INTO tender.enrichment_versions(run_id,tender_id,version,source_code,notice_identifier,notice_version,change_state,retrieved_at,source_url,payload_sha256,raw_payload,raw_content_type,structured_data,quality_summary,mapper_version,parser_version) VALUES($1,$2,$3,'DOE',$4,$5,'RECOVERED_FROM_PUBLIC_API',now(),$6,$7,$8,'application/json',$9::jsonb,$10::jsonb,$11,$11) RETURNING id`, [runId, tender.id, version, tender.external_id, String(version), tender.source_url, result.payloadSha256, result.rawPayload, json(result.structured), json({ deduplicated: true, recovered: true, fieldCount: result.fields.length, lotCount: result.lots.length }), VERSION])).rows[0];
        for (const lot of result.lots) await client.query("INSERT INTO tender.enrichment_lots(enrichment_version_id,lot_key,lot_number,title,structured_data,provenance) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)", [enrichment.id, lot.lotKey, lot.lotNumber, lot.title, json(lot), json(lot.provenance)]);
        for (const field of result.fields) await client.query("INSERT INTO tender.enrichment_fields(enrichment_version_id,field_key,value,quality_status,provenance,confidence) VALUES($1,$2,$3::jsonb,$4,$5::jsonb,$6)", [enrichment.id, field.fieldKey, json(field.value), field.qualityStatus, json(field.provenance), field.confidence]);
        for (const link of result.documentLinks) await client.query("INSERT INTO tender.enrichment_documents(enrichment_version_id,source_url,document_type,filename,fetch_status,provenance) VALUES($1,$2,'TENDER_DOCUMENT',$3,'DOKUMENT_NOCH_NICHT_ABGERUFEN',$4::jsonb)", [enrichment.id, link, new URL(link).pathname.split("/").pop() || null, json({ sourceNotice: tender.source_url, discoveredAt: new Date().toISOString() })]);
        await client.query("COMMIT");
        stats.enriched++;
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    } catch (error) { stats.failed++; console.error(JSON.stringify({ tenderId: tender.id, error: error.message })); }
  }
  await pool.query("UPDATE tender.enrichment_runs SET status=$2,finished_at=now(),total=$3,enriched=$4,metadata=$5::jsonb WHERE id=$1", [runId, stats.failed ? "SUCCESS_WITH_WARNINGS" : "SUCCESS", stats.total, stats.enriched, json(stats)]);
  console.log(JSON.stringify({ runId, ...stats }));
} finally { await pool.end(); }
