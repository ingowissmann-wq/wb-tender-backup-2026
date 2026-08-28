import {readFileSync} from "node:fs";
import pg from "pg";

const connectionString=process.env.DATABASE_URL||readFileSync(process.env.DATABASE_URL_FILE,"utf8").trim();
const dryRun=process.env.PORTAL_STATUS_BACKFILL_APPLY!=="true";
const pool=new pg.Pool({connectionString,max:1});
const activeHostsSql=`WITH active AS(
  SELECT DISTINCT t.id FROM tender.tenders t JOIN tender.current_service_relevance r ON r.tender_id=t.id
  WHERE t.data_class='PUBLIC_REAL' AND t.archived_at IS NULL AND coalesce(t.offer_deadline,t.participation_deadline)>now()
    AND r.relevance_status='RELEVANT' AND r.service_scope_gate='PASSED' AND r.primary_company
), latest AS(SELECT DISTINCT ON(tender_id) id,tender_id FROM tender.enrichment_versions ORDER BY tender_id,version DESC)
SELECT DISTINCT lower(split_part(split_part(d.source_url,'://',2),'/',1)) host
FROM active a JOIN latest e ON e.tender_id=a.id JOIN tender.enrichment_documents d ON d.enrichment_version_id=e.id
WHERE d.source_url LIKE 'https://%'`;
try{
  const client=await pool.connect();try{await client.query("BEGIN");const activeHosts=(await client.query(activeHostsSql)).rows.map(row=>row.host),rows=(await client.query("SELECT * FROM tender.portal_registry ORDER BY canonical_domain FOR UPDATE")).rows,changes=[];
    for(const row of rows){const active=activeHosts.includes(row.canonical_domain)||(row.allowed_subdomains||[]).some(host=>activeHosts.includes(host))||(row.download_domains||[]).some(host=>activeHosts.includes(host));let status;
      if(["dtvp","rib-meinauftrag","vergabe24"].includes(row.adapter_id)&&row.last_successful_document_fetch_at)status="VALIDATED_REAL";
      else if(row.adapter_id==="deutsche-evergabe"&&row.last_successful_document_fetch_at)status="VALIDATED_READ_ONLY";
      else if(row.adapter_id==="evergabe-de")status="TEMPORARILY_UNREACHABLE";
      else if(row.adapter_id==="evergabe-bayern")status="NEEDS_ADAPTER_IMPLEMENTATION";
      else if(row.adapter_validation_status==="CREDENTIAL_REQUIRED"||row.last_error_code==="PORTALZUGANG_NICHT_KONFIGURIERT")status="NEEDS_CREDENTIALS";
      else status=active?"NEEDS_ADAPTER_IMPLEMENTATION":"NO_ACTIVE_TENDER_FOR_VALIDATION";
      if(status!==row.adapter_validation_status){changes.push({portalId:row.id,domain:row.canonical_domain,from:row.adapter_validation_status,to:status,activeTender:active});if(!dryRun)await client.query("UPDATE tender.portal_registry SET adapter_validation_status=$2,updated_at=now() WHERE id=$1",[row.id,status])}
    }
    if(!dryRun)await client.query("INSERT INTO tender.audit_events(action,metadata) VALUES('portal_adapter_status_backfill',$1::jsonb)",[JSON.stringify({contractVersion:"2.0.0",changed:changes.length,activeHosts:activeHosts.length,externalWrite:false})]);
    await client.query(dryRun?"ROLLBACK":"COMMIT");console.log(JSON.stringify({dryRun,registered:rows.length,activeHosts:activeHosts.length,changed:changes.length,changes},null,2));
  }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
}finally{await pool.end()}
