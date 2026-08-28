import fs from "node:fs";
import pg from "pg";
import { createFixedScopedPool, loadBackgroundScope } from "../platform/scoped-pg-pool.mjs";

const connectionString=process.env.DATABASE_URL||fs.readFileSync(
  process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8",
).trim();
const rawPool=new pg.Pool({connectionString,max:1,options:["-c default_transaction_read_only=on -c statement_timeout=120000",process.env.DATABASE_SESSION_OPTIONS].filter(Boolean).join(" ")});
const pool=createFixedScopedPool(rawPool,await loadBackgroundScope(rawPool)).pool;
const client=await pool.connect();
const grouped=async expression=>(await client.query(`SELECT coalesce(${expression},'<NULL>') value,count(*)::int count
  FROM tender.enrichment_documents WHERE procurement_relevant GROUP BY 1 ORDER BY count(*) DESC,1`)).rows;

try{
  await client.query("BEGIN READ ONLY");
  const totals=(await client.query(`SELECT count(*)::int relevant,
      count(*) FILTER(WHERE content IS NOT NULL AND payload_sha256 IS NOT NULL)::int payload_present,
      count(*) FILTER(WHERE procurement_verification_status='VERIFIED')::int verified,
      count(*) FILTER(WHERE tender_association_verified)::int tender_association_verified,
      count(*) FILTER(WHERE lot_association_verified)::int lot_association_verified,
      count(*) FILTER(WHERE lot_id IS NULL)::int tender_global_or_unassigned,
      count(*) FILTER(WHERE magic_bytes_verified)::int magic_bytes_verified,
      count(*) FILTER(WHERE parser IS NOT NULL)::int parsed,
      count(*) FILTER(WHERE extracted_data IS NOT NULL)::int extracted
    FROM tender.enrichment_documents WHERE procurement_relevant`)).rows[0];
  const [verificationStatuses,fetchStatuses,resolutionStatuses,documentClasses,mimeTypes]=await Promise.all([
    grouped("procurement_verification_status"),grouped("fetch_status"),grouped("resolution_status"),
    grouped("document_class"),grouped("mime_type"),
  ]);
  const openByReason=(await client.query(`SELECT coalesce(procurement_verification_status,'<NULL>') verification_status,
      coalesce(fetch_status,'<NULL>') fetch_status,coalesce(resolution_status,'<NULL>') resolution_status,
      tender_association_verified,lot_association_verified,magic_bytes_verified,
      (content IS NOT NULL AND payload_sha256 IS NOT NULL) payload_present,count(*)::int count
    FROM tender.enrichment_documents
    WHERE procurement_relevant AND procurement_verification_status IS DISTINCT FROM 'VERIFIED'
    GROUP BY 1,2,3,4,5,6,7 ORDER BY count(*) DESC`)).rows;
  const malwareScans=(await client.query(`SELECT scan.status,count(*)::int count
    FROM tender.document_malware_scans scan
    JOIN tender.enrichment_documents document
      ON document.id=scan.document_id AND document.payload_sha256=scan.payload_sha256
    WHERE document.procurement_relevant GROUP BY scan.status ORDER BY count(*) DESC`)).rows;
  const openScanTruth=(await client.query(`SELECT scan.status,
      count(*) FILTER(WHERE document.procurement_verification_status IS DISTINCT FROM 'VERIFIED')::int open_documents,
      count(*) FILTER(WHERE document.procurement_verification_status='VERIFIED')::int verified_documents
    FROM tender.document_malware_scans scan
    JOIN tender.enrichment_documents document
      ON document.id=scan.document_id AND document.payload_sha256=scan.payload_sha256
    WHERE document.procurement_relevant GROUP BY scan.status ORDER BY scan.status`)).rows;
  const quarantinedReasons=(await client.query(`SELECT coalesce(scan.detail_code,'<NULL>') detail_code,count(*)::int count
    FROM tender.document_malware_scans scan
    JOIN tender.enrichment_documents document
      ON document.id=scan.document_id AND document.payload_sha256=scan.payload_sha256
    WHERE document.procurement_relevant AND scan.status='QUARANTINED'
    GROUP BY 1 ORDER BY count(*) DESC`)).rows;
  const quarantinedTechnicalProfile=(await client.query(`SELECT
      coalesce(scan.detail_code,'<NULL>') detail_code,
      CASE
        WHEN octet_length(document.content)>100*1024*1024 THEN '>100MiB'
        WHEN octet_length(document.content)>50*1024*1024 THEN '50-100MiB'
        WHEN octet_length(document.content)>10*1024*1024 THEN '10-50MiB'
        ELSE '<=10MiB'
      END size_bucket,
      count(*) FILTER(WHERE document.content_size IS DISTINCT FROM octet_length(document.content))::int content_size_mismatch,
      min(scan.attempt)::int min_attempt,
      max(scan.attempt)::int max_attempt,
      count(*) FILTER(WHERE scan.next_retry_at IS NULL OR scan.next_retry_at<=now())::int retry_due,
      count(*)::int count
    FROM tender.document_malware_scans scan
    JOIN tender.enrichment_documents document
      ON document.id=scan.document_id AND document.payload_sha256=scan.payload_sha256
    WHERE document.procurement_relevant AND scan.status='QUARANTINED'
    GROUP BY 1,2 ORDER BY count(*) DESC,1,2`)).rows;
  const cleanOpenProvenance=(await client.query(`SELECT
      coalesce(document.provenance->>'procurementVerified','<NULL>') procurement_verified_before_scan,
      coalesce(document.provenance->>'statusGuard','<NULL>') status_guard,
      coalesce(document.provenance->>'lotScope','<NULL>') lot_scope,
      count(*)::int count
    FROM tender.enrichment_documents document
    JOIN tender.document_malware_scans scan
      ON scan.document_id=document.id AND scan.payload_sha256=document.payload_sha256 AND scan.status='CLEAN'
    WHERE document.procurement_relevant AND document.procurement_verification_status IS DISTINCT FROM 'VERIFIED'
    GROUP BY 1,2,3 ORDER BY count(*) DESC`)).rows;
  const parserErrorTechnicalProfile=(await client.query(`SELECT
      coalesce(document.mime_type,'<NULL>') mime_type,
      coalesce(document.parser,'<NULL>') parser,
      coalesce(document.parser_version,'<NULL>') parser_version,
      coalesce(document.resolution_status,'<NULL>') resolution_status,
      CASE WHEN document.filename~'\\.[A-Za-z0-9]{1,10}$'
        THEN lower(substring(document.filename from '\\.([^.]+)$')) ELSE '<NONE>' END filename_extension,
      CASE
        WHEN octet_length(document.content)>100*1024*1024 THEN '>100MiB'
        WHEN octet_length(document.content)>50*1024*1024 THEN '50-100MiB'
        WHEN octet_length(document.content)>10*1024*1024 THEN '10-50MiB'
        ELSE '<=10MiB'
      END size_bucket,
      count(*)::int count
    FROM tender.enrichment_documents document
    WHERE document.procurement_relevant AND document.fetch_status='PARSER_FEHLER'
    GROUP BY 1,2,3,4,5,6 ORDER BY count(*) DESC,1,2`)).rows;
  await client.query("ROLLBACK");
  console.log(JSON.stringify({capturedAt:new Date().toISOString(),transaction:"READ_ONLY_ROLLED_BACK",totals,
    verificationStatuses,fetchStatuses,resolutionStatuses,documentClasses,mimeTypes,openByReason,
    malwareScans,openScanTruth,quarantinedReasons,quarantinedTechnicalProfile,cleanOpenProvenance,
    parserErrorTechnicalProfile},null,2));
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{await client.release();await rawPool.end()}
