import fs from "node:fs";
import pg from "pg";
import { createFixedScopedPool, loadBackgroundScope } from "../platform/scoped-pg-pool.mjs";

const connectionString=process.env.DATABASE_URL||fs.readFileSync(process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8").trim(),
  rawPool=new pg.Pool({connectionString,max:1,options:"-c default_transaction_read_only=on -c statement_timeout=120000"}),
  pool=createFixedScopedPool(rawPool,await loadBackgroundScope(rawPool)).pool,client=await pool.connect();
try{
  await client.query("BEGIN READ ONLY");
  const byFormat=(await client.query(`SELECT
      coalesce(d.mime_type,'NO_SOURCE') mime_type,r.requirement_classification,r.satisfaction_status,
      count(*)::int count,
      count(*) FILTER(WHERE r.mandatory AND r.submission_relevant AND r.manual_submission_relevance_override IS DISTINCT FROM false AND r.satisfaction_status<>'SUPERSEDED')::int active_required,
      count(*) FILTER(WHERE d.procurement_verification_status='VERIFIED')::int verified_source,
      count(*) FILTER(WHERE d.provenance->'originalFormMapping'->>'requirementId'=r.id::text
        AND d.provenance->'originalFormMapping'->>'tenderId'=r.tender_id::text
        AND d.provenance->'originalFormMapping'->>'companyId'=r.company_id::text
        AND coalesce(d.provenance->'originalFormMapping'->>'lotKey','')=coalesce(r.lot_key,''))::int exact_mapping
    FROM tender.required_documents r
    JOIN tender.tenders t ON t.id=r.tender_id AND t.data_class='PUBLIC_REAL' AND t.source_lifecycle_status='ACTIVE'
    LEFT JOIN tender.enrichment_documents d ON d.id=r.source_document_id
    GROUP BY coalesce(d.mime_type,'NO_SOURCE'),r.requirement_classification,r.satisfaction_status
    ORDER BY active_required DESC,count(*) DESC,mime_type,r.requirement_classification,r.satisfaction_status`)).rows;
  const exactEditable=(await client.query(`SELECT r.id required_document_id,r.tender_id,r.company_id,r.lot_key,
      d.id source_document_id,d.mime_type,d.filename,d.payload_sha256,d.content,
      r.requirement_title,r.satisfaction_status
    FROM tender.required_documents r
    JOIN tender.tenders t ON t.id=r.tender_id AND t.data_class='PUBLIC_REAL' AND t.source_lifecycle_status='ACTIVE'
    JOIN tender.enrichment_documents d ON d.id=r.source_document_id AND d.procurement_verification_status='VERIFIED'
    WHERE r.mandatory AND r.submission_relevant AND r.manual_submission_relevance_override IS DISTINCT FROM false AND r.satisfaction_status<>'SUPERSEDED'
      AND r.requirement_classification='FILLABLE_BIDDER_FORM'
      AND d.mime_type IN('application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      AND d.provenance->'originalFormMapping'->>'requirementId'=r.id::text
      AND d.provenance->'originalFormMapping'->>'tenderId'=r.tender_id::text
      AND d.provenance->'originalFormMapping'->>'companyId'=r.company_id::text
      AND coalesce(d.provenance->'originalFormMapping'->>'lotKey','')=coalesce(r.lot_key,'')
    ORDER BY d.mime_type,r.tender_id,r.company_id,r.lot_key,r.id`)).rows;
  const safeItems=exactEditable.map(row=>({
    requiredDocumentId:row.required_document_id,tenderId:row.tender_id,companyId:row.company_id,
    lotKey:row.lot_key,sourceDocumentId:row.source_document_id,mimeType:row.mime_type,
    filename:String(row.filename||"").replaceAll("\\","/").split("/").pop().slice(0,180),
    payloadSha256Present:/^[0-9a-f]{64}$/i.test(String(row.payload_sha256||"")),
    sizeBytes:row.content?.length||0,requirementTitle:row.requirement_title,status:row.satisfaction_status,
  }));
  await client.query("ROLLBACK");
  console.log(JSON.stringify({capturedAt:new Date().toISOString(),transaction:"READ_ONLY_ROLLED_BACK",
    byFormat,exactEditableCount:safeItems.length,exactEditable:safeItems,externalWrite:false,transmitted:false},null,2));
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{await client.release();await rawPool.end()}
