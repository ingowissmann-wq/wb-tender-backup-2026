import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import {parseNotice} from "../platform/enrichment-core.mjs";
import {createFixedScopedPool,loadBackgroundScope} from "../platform/scoped-pg-pool.mjs";

const TARGETS=Object.freeze(["472413-2026","539541-2026","540350-2026","551624-2026","552392-2026"]);
const CONTEXT_TARGETS=new Set(["472413-2026","540350-2026","552392-2026"]);
const PARSER_VERSION="ted-munich-context-repair-1.0";
const apply=process.argv.includes("--apply");
const expected=process.argv.find(value=>value.startsWith("--expected-plan-sha256="))?.split("=")[1]||"";
const stable=value=>Array.isArray(value)?`[${value.map(stable).join(",")}]`:value&&typeof value==="object"?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`:JSON.stringify(value);
const hash=value=>crypto.createHash("sha256").update(Buffer.isBuffer(value)?value:typeof value==="string"?value:stable(value)).digest("hex");
const connectionString=process.env.DATABASE_URL||fs.readFileSync(process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8").trim();
const rawPool=new pg.Pool({connectionString,max:1,options:[!apply?"-c default_transaction_read_only=on":"","-c statement_timeout=180000",process.env.DATABASE_SESSION_OPTIONS].filter(Boolean).join(" ")});
const pool=createFixedScopedPool(rawPool,await loadBackgroundScope(rawPool)).pool;
const q=async(text,params=[])=>(await pool.query(text,params)).rows;
const fetchXml=async externalId=>{
  const url=`https://ted.europa.eu/en/notice/${encodeURIComponent(externalId)}/xml`;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30_000);
  try{
    const response=await fetch(url,{headers:{accept:"application/xml","user-agent":"WB-Tender-Context-Repair/1.0"},redirect:"error",signal:controller.signal});
    if(!response.ok||!/^application\/xml(?:;|$)/i.test(response.headers.get("content-type")||""))throw new Error(`ted_xml_invalid:${externalId}:${response.status}`);
    const buffer=Buffer.from(await response.arrayBuffer());
    if(buffer.length<100||buffer.length>10_000_000)throw new Error(`ted_xml_size_invalid:${externalId}`);
    return {url,buffer,payloadSha256:hash(buffer),contentType:(response.headers.get("content-type")||"application/xml").split(";")[0]};
  }finally{clearTimeout(timer)}
};

const tenders=await q(`SELECT tender.*,version.id tender_version_id,version.version tender_version,
    document_link.id document_link_id,coalesce(document_link.final_url,document_link.original_url) document_url,
    document_link.evidence_sha256 document_evidence_sha256,portal.id portal_id,portal.canonical_domain,
    portal.adapter_id portal_adapter_id
  FROM tender.tenders tender
  JOIN LATERAL(SELECT id,version FROM tender.tender_versions WHERE tender_id=tender.id ORDER BY version DESC,created_at DESC,id DESC LIMIT 1) version ON true
  JOIN LATERAL(SELECT * FROM tender.tender_external_links WHERE tender_id=tender.id AND role='PROCUREMENT_DOCUMENT'
    AND lower(coalesce(final_host,original_host))='vergabe.muenchen.de' ORDER BY created_at DESC LIMIT 1) document_link ON true
  JOIN tender.portal_registry portal ON portal.canonical_domain='vergabe.muenchen.de'
  WHERE tender.external_id=ANY($1::text[]) AND tender.source_code='TED' AND tender.data_class='PUBLIC_REAL'
    AND tender.source_lifecycle_status='ACTIVE' ORDER BY tender.external_id`,[TARGETS]);
if(tenders.length!==TARGETS.length)throw new Error("ted_munich_target_inventory_incomplete");
const safety=(await q("SELECT external_submission_enabled,allow_external_submission,global_kill_switch FROM tender.submission_runtime_settings"))[0];
if(safety?.external_submission_enabled||safety?.allow_external_submission||safety?.global_kill_switch!==true)throw new Error("submission_safety_not_locked");
const items=[];
for(const tender of tenders){
  const fetched=await fetchXml(tender.external_id),parsed=parseNotice(fetched.buffer,{source:"TED",url:fetched.url,contentType:fetched.contentType,fallback:tender});
  const canonicalLots=await q("SELECT id,external_id,title FROM tender.lots WHERE tender_id=$1 ORDER BY external_id",[tender.id]);
  const parsedLotKeys=[...new Set(parsed.lots.map(lot=>lot.lotKey))].sort(),canonicalLotKeys=canonicalLots.map(lot=>lot.external_id).sort();
  if(stable(parsedLotKeys)!==stable(canonicalLotKeys))throw new Error(`ted_lot_set_mismatch:${tender.external_id}`);
  const contexts=CONTEXT_TARGETS.has(tender.external_id)?await q(`SELECT context.id,context.tenant_id,context.company_id,company.legal_name,
      scope.canonical_service,selection.source_lot_id selected_lot_key,selection.lot_id selected_lot_id
    FROM tender.pipeline_contexts context JOIN tender.enterprise_company_links company ON company.company_id=context.company_id
    JOIN tender.configuration_scopes scope ON scope.company_id=context.company_id AND scope.profile_id=company.tender_profile_id
    LEFT JOIN tender.tender_lot_selections selection ON selection.tenant_id=context.tenant_id AND selection.company_id=context.company_id
      AND selection.tender_id=context.tender_id
    WHERE context.tender_id=$1 ORDER BY context.id,selection.source_lot_id`,[tender.id]):[];
  const contextIds=[...new Set(contexts.map(row=>row.id))];
  if(CONTEXT_TARGETS.has(tender.external_id)&&contextIds.length!==1)throw new Error(`pipeline_context_count_invalid:${tender.external_id}`);
  const selected=[...new Set(contexts.map(row=>row.selected_lot_key).filter(Boolean))];
  if(contexts[0]&&canonicalLots.length===1&&(selected.length!==1||selected[0]!==canonicalLots[0].external_id))throw new Error(`single_lot_selection_missing:${tender.external_id}`);
  if(contexts[0]&&canonicalLots.length>1&&selected.length)throw new Error(`unexpected_multi_lot_selection:${tender.external_id}`);
  items.push({tenderId:tender.id,externalId:tender.external_id,tenderVersionId:tender.tender_version_id,tenderVersion:Number(tender.tender_version),
    documentUrl:tender.document_url,documentEvidenceSha256:tender.document_evidence_sha256,portalId:tender.portal_id,
    portalDomain:tender.canonical_domain,portalAdapterId:tender.portal_adapter_id,xmlUrl:fetched.url,payloadSha256:fetched.payloadSha256,
    parsedLotKeys,canonicalLots,context:contexts[0]?{id:contexts[0].id,tenantId:contexts[0].tenant_id,companyId:contexts[0].company_id,
      company:contexts[0].legal_name,canonicalService:contexts[0].canonical_service,selectedLotKey:selected[0]||null,
      selectedLotId:contexts.find(row=>row.selected_lot_key===selected[0])?.selected_lot_id||null}:null,
    expectedContextStatus:contexts[0]?(canonicalLots.length===1?"CANONICAL":"TENDER_GLOBAL"):null,parsed,fetched});
}
const plan={schemaVersion:1,parserVersion:PARSER_VERSION,targets:items.map(({parsed,fetched,...item})=>item),
  externalWrite:false,externalSubmission:false,transmitted:false};
const planSha256=hash(plan);
if(!apply){console.log(JSON.stringify({mode:"READ_ONLY_PLAN",planSha256,plan,safety,requiredApplyArgument:`--expected-plan-sha256=${planSha256}`},null,2));await rawPool.end();process.exit(0)}
if(expected!==planSha256)throw new Error("ted_munich_plan_hash_mismatch");

const client=await pool.connect();
const stats={enrichmentsInserted:0,enrichmentsReused:0,lotsInserted:0,fieldsInserted:0,documentsRegistered:0,
  contextBindingsInserted:0,contextsCanonical:0,contextsTenderGlobal:0,documentResolutionsUpserted:0,documentAssignmentsUpserted:0};
try{
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ted-munich-context-repair',0))");
  const run=(await client.query("INSERT INTO tender.enrichment_runs(kind,status,mapper_version,parser_version,metadata) VALUES('TED_MUNICH_CONTEXT_REPAIR','RUNNING',$1,$1,$2::jsonb) RETURNING id",[PARSER_VERSION,JSON.stringify({planSha256,targets:TARGETS,externalWrite:false,externalSubmission:false})])).rows[0];
  for(const item of items){
    const locked=(await client.query("SELECT id,source_lifecycle_status FROM tender.tenders WHERE id=$1 FOR SHARE",[item.tenderId])).rows[0];
    if(!locked||locked.source_lifecycle_status!=="ACTIVE")throw new Error(`tender_changed:${item.externalId}`);
    let enrichment=(await client.query("SELECT id,version FROM tender.enrichment_versions WHERE tender_id=$1 AND payload_sha256=$2 AND parser_version=$3 ORDER BY version DESC LIMIT 1",[item.tenderId,item.payloadSha256,PARSER_VERSION])).rows[0];
    if(!enrichment){
      const version=Number((await client.query("SELECT coalesce(max(version),0)+1 version FROM tender.enrichment_versions WHERE tender_id=$1",[item.tenderId])).rows[0].version);
      enrichment=(await client.query(`INSERT INTO tender.enrichment_versions(run_id,tender_id,version,source_code,notice_identifier,notice_version,
        change_state,retrieved_at,source_url,payload_sha256,raw_payload,raw_content_type,structured_data,quality_summary,mapper_version,parser_version)
        VALUES($1,$2,$3,'TED',$4,$5,'AUTHORITATIVE_CONTEXT_REPAIR',now(),$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$12) RETURNING id,version`,
        [run.id,item.tenderId,version,item.externalId,String(item.tenderVersion),item.xmlUrl,item.payloadSha256,item.fetched.buffer,item.fetched.contentType,
          JSON.stringify(item.parsed.structured),JSON.stringify({authoritativeTedXml:true,planSha256,fieldCount:item.parsed.fields.length,lotCount:item.parsed.lots.length}),PARSER_VERSION])).rows[0];
      stats.enrichmentsInserted++;
      for(const lot of item.parsed.lots){await client.query(`INSERT INTO tender.enrichment_lots(enrichment_version_id,lot_key,lot_number,title,structured_data,provenance)
        VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,[enrichment.id,lot.lotKey,lot.lotNumber,lot.title,JSON.stringify(lot),JSON.stringify({...lot.provenance,planSha256})]);stats.lotsInserted++}
      for(const field of item.parsed.fields){await client.query(`INSERT INTO tender.enrichment_fields(enrichment_version_id,field_key,value,quality_status,provenance,confidence)
        VALUES($1,$2,$3::jsonb,$4,$5::jsonb,$6) ON CONFLICT(enrichment_version_id,lot_id,field_key) DO NOTHING`,[enrichment.id,field.fieldKey,JSON.stringify(field.value),field.qualityStatus,JSON.stringify({...field.provenance,planSha256}),field.confidence]);stats.fieldsInserted++}
      for(const url of item.parsed.documentLinks){await client.query(`INSERT INTO tender.enrichment_documents(enrichment_version_id,source_url,document_type,filename,fetch_status,provenance)
        VALUES($1,$2,'TENDER_DOCUMENT',$3,'DOKUMENT_NOCH_NICHT_ABGERUFEN',$4::jsonb) ON CONFLICT(enrichment_version_id,source_url) DO NOTHING`,
        [enrichment.id,url,new URL(url).pathname.split('/').pop()||null,JSON.stringify({sourceNotice:item.xmlUrl,planSha256,externalWrite:false})]);stats.documentsRegistered++}
    }else stats.enrichmentsReused++;
    await client.query(`INSERT INTO tender.tender_portal_resolutions(tender_id,tender_version_id,portal_id,exact_host,evidence_url,evidence_role,evidence_priority,resolution_status,evidence,evidence_sha256)
      VALUES($1,$2,$3,$4,$5,'PROCUREMENT_DOCUMENT',100,'UNIQUE_EVIDENCE',$6::jsonb,$7)
      ON CONFLICT(tender_version_id,(coalesce(evidence_role,''))) DO UPDATE SET portal_id=excluded.portal_id,exact_host=excluded.exact_host,
        evidence_url=excluded.evidence_url,evidence_priority=excluded.evidence_priority,resolution_status=excluded.resolution_status,
        evidence=excluded.evidence,evidence_sha256=excluded.evidence_sha256,updated_at=now()`,[item.tenderId,item.tenderVersionId,item.portalId,item.portalDomain,item.documentUrl,
        JSON.stringify({source:"TED_OFFICIAL_NOTICE",role:"PROCUREMENT_DOCUMENT",planSha256,submissionPortalDistinct:true}),item.documentEvidenceSha256]);
    stats.documentResolutionsUpserted++;
    if(item.context){
      if(item.context.selectedLotKey){
        await client.query(`INSERT INTO tender.enrichment_context_bindings(enrichment_version_id,tenant_id,company_id,tender_id,tender_version_id,lot_id,source_lot_id,canonical_service,source_manifest_sha256)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[enrichment.id,item.context.tenantId,item.context.companyId,item.tenderId,item.tenderVersionId,
          item.context.selectedLotId,item.context.selectedLotKey,item.context.canonicalService,item.payloadSha256]);stats.contextBindingsInserted++;
        await client.query(`INSERT INTO tender.tender_portal_assignments(tenant_id,company_id,tender_id,tender_version_id,lot_id,source_lot_id,canonical_service,portal_id,exact_host,assignment_source,status,evidence_sha256,portal_role)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'UNIQUE_EVIDENCE','ACTIVE',$10,'DOCUMENT_PORTAL')
          ON CONFLICT(tenant_id,company_id,tender_id,canonical_service,(coalesce(source_lot_id,'')),portal_role) WHERE status='ACTIVE'
          DO UPDATE SET tender_version_id=excluded.tender_version_id,lot_id=excluded.lot_id,portal_id=excluded.portal_id,exact_host=excluded.exact_host,evidence_sha256=excluded.evidence_sha256`,
          [item.context.tenantId,item.context.companyId,item.tenderId,item.tenderVersionId,item.context.selectedLotId,item.context.selectedLotKey,item.context.canonicalService,item.portalId,item.portalDomain,item.documentEvidenceSha256]);
        stats.documentAssignmentsUpserted++;
        await client.query("UPDATE tender.pipeline_contexts SET lot_key=$2,company_id=company_id WHERE id=$1",[item.context.id,item.context.selectedLotKey]);
      }else await client.query("UPDATE tender.pipeline_contexts SET lot_key='',company_id=company_id WHERE id=$1",[item.context.id]);
      const verified=(await client.query("SELECT context_integrity_status,lot_id,enrichment_version_id FROM tender.pipeline_contexts WHERE id=$1",[item.context.id])).rows[0];
      if(verified.context_integrity_status!==item.expectedContextStatus||!verified.enrichment_version_id||
        (item.expectedContextStatus==='CANONICAL'&&!verified.lot_id)||(item.expectedContextStatus==='TENDER_GLOBAL'&&verified.lot_id))throw new Error(`context_postcondition_failed:${item.externalId}`);
      if(verified.context_integrity_status==='CANONICAL')stats.contextsCanonical++;else stats.contextsTenderGlobal++;
    }
  }
  const finalSafety=(await client.query("SELECT external_submission_enabled,allow_external_submission,global_kill_switch FROM tender.submission_runtime_settings FOR SHARE")).rows[0];
  if(finalSafety.external_submission_enabled||finalSafety.allow_external_submission||finalSafety.global_kill_switch!==true)throw new Error("submission_safety_changed");
  await client.query("UPDATE tender.enrichment_runs SET status='SUCCESS',finished_at=now(),total=$2,enriched=$3,metadata=$4::jsonb WHERE id=$1",[run.id,items.length,stats.enrichmentsInserted,JSON.stringify({planSha256,...stats,externalWrite:false,externalSubmission:false,transmitted:false})]);
  await client.query("INSERT INTO tender.audit_events(action,metadata) VALUES('TED_MUNICH_CONTEXTS_REPAIRED',$1::jsonb)",[JSON.stringify({planSha256,targets:TARGETS,...stats,externalWrite:false,externalSubmission:false,transmitted:false})]);
  await client.query("COMMIT");
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{await client.release();await rawPool.end()}
console.log(JSON.stringify({mode:"APPLIED",planSha256,...stats,externalWrite:false,externalSubmission:false,transmitted:false},null,2));
