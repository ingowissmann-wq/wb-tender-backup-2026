import crypto from "node:crypto";
import {classifyRegion} from "./region-gate.mjs";

export const INBOX_PIPELINE_VERSION="wb-daily-inbox-pipeline/2.1.0-canonical-lot-context";
const json=value=>JSON.stringify(value??null);
const hash=value=>crypto.createHash("sha256").update(json(value)).digest("hex");
const unique=values=>[...new Set((values||[]).flat().filter(value=>value!==null&&value!==undefined&&String(value).trim()).map(value=>String(value).trim()))];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeExactContextBindings(values=[]){
  const result=[],seen=new Set();
  for(const value of values||[]){
    const tenderId=String(value?.tenderId||value?.tender_id||"").trim(),companyId=String(value?.companyId||value?.company_id||"").trim(),lotKey=String(value?.lotKey??value?.lot_key??"").trim();
    if(!uuid.test(tenderId)||!uuid.test(companyId)||!lotKey)throw Object.assign(new Error("exact_context_binding_invalid"),{code:"EXACT_CONTEXT_BINDING_INVALID"});
    const key=`${tenderId}:${companyId}:${lotKey}`;if(seen.has(key))throw Object.assign(new Error("exact_context_binding_duplicate"),{code:"EXACT_CONTEXT_BINDING_DUPLICATE"});
    seen.add(key);result.push({tender_id:tenderId,company_id:companyId,lot_key:lotKey});
  }
  return result;
}

const lotIdentity = (value) => String(value ?? "").trim();
const lotMatches = (lot, lotKey) => [lot?.lot_key,lot?.lotKey,lot?.external_id,lot?.externalId,lot?.id,lot?.lot_number,lot?.lotNumber]
  .some((value)=>lotIdentity(value)===lotIdentity(lotKey));
const addressLocation = address => ({region:address?.region||null,nuts:address?.nuts||null,locality:address?.locality||address?.city||null,postalCode:address?.postalCode||address?.postal_code||null,country:address?.countryName||address?.country||null,latitude:address?.latitude??address?.lat??null,longitude:address?.longitude??address?.lon??null});

export function extractSourceLocations(tender,normalized={},lotKey=null){
  const normalizedLots=[...(Array.isArray(normalized.lots)?normalized.lots:[]),...(Array.isArray(normalized.raw?.tender?.items)?normalized.raw.tender.items:[])];
  if(lotKey&&normalizedLots.length){
    const matched=normalizedLots.filter(lot=>lotMatches(lot,lotKey));
    if(matched.length){
      return matched.flatMap(lot=>[
        ...(Array.isArray(lot.locations)?lot.locations:[]),
        ...(Array.isArray(lot.deliveryAddresses)?lot.deliveryAddresses:[]),
        lot.deliveryAddress,
      ].filter(Boolean).map(addressLocation));
    }
    if(normalized.sourceCode==="DOE"||tender.source_code==="DOE")return [];
  }
  if(Array.isArray(normalized.locations))return normalized.locations.map(addressLocation);
  if(normalized.sourceCode==="DOE"||tender.source_code==="DOE")return (normalized.raw?.tender?.items||[]).map(item=>item?.deliveryAddress).filter(Boolean).map(addressLocation);
  return unique(normalized.raw?.["place-of-performance"]||tender.regions||[]).map(region=>({region}));
}

export function documentPipelineStatus(documents=[]){
  if(!documents.length)return "NOT_DISCOVERED_IN_SOURCE_SYNC";
  if(documents.some(item=>["DOWNLOAD_FAILED","DOWNLOAD_FEHLGESCHLAGEN","TECHNISCHER_CONNECTORFEHLER"].includes(item.resolution_status||item.fetch_status)))return "DOWNLOAD_FAILED_REVIEWABLE";
  if(documents.some(item=>["DOWNLOAD_SUCCEEDED","VORHANDEN"].includes(item.resolution_status||item.fetch_status)))return "AVAILABLE";
  return "PENDING_REVIEWABLE";
}

export function inboxDecision(region){
  if(region.classification==="CORE_REGION")return {decision:"PRELIMINARY_GO",next:"WEITERE_MINDESTGATES_PRUEFEN",exclusion:null};
  if(region.classification==="NOT_APPLICABLE")return {decision:"NOT_ASSESSABLE",next:"KEINE_REGIONSAKTION",exclusion:"SERVICE_NOT_APPLICABLE"};
  return {decision:"REVIEW_REQUIRED",next:region.nextAction||"REGION_PRUEFEN",exclusion:region.classification};
}

async function loadConfiguration(client,companyIds){
 if(!companyIds.length)return new Map();
  const rows=(await client.query(`SELECT scope.company_id,CASE scope.canonical_service WHEN 'facility_management' THEN 'facility-management' WHEN 'emergency_services' THEN 'emergency-services' ELSE scope.canonical_service END service_line,a.parameter_key,c.new_value,v.id version_id,v.version_no,
    scope.tenant_id,scope.canonical_service,scope.profile_id,scope.active_region_version_id,region_version.configuration_version_id region_configuration_version_id
    FROM tender.configuration_scopes scope LEFT JOIN tender.configuration_active_parameters a ON a.company_id=scope.company_id
      AND (CASE a.service_line WHEN 'facility-management' THEN 'facility_management' WHEN 'emergency-services' THEN 'emergency_services' ELSE a.service_line END)=scope.canonical_service AND a.parameter_key IN('A08','A09','A10','B07')
    LEFT JOIN tender.configuration_versions v ON v.id=a.version_id AND v.status='ACTIVE' AND v.tenant_id=scope.tenant_id AND v.company_id=scope.company_id AND v.canonical_service=scope.canonical_service AND v.profile_id=scope.profile_id
    LEFT JOIN tender.configuration_changes c ON c.id=a.change_id AND c.version_id=v.id
    LEFT JOIN tender.region_profile_versions region_version ON region_version.id=scope.active_region_version_id AND region_version.status='ACTIVE'
    WHERE scope.company_id=ANY($1::uuid[])
    ORDER BY scope.company_id,scope.canonical_service,a.parameter_key,v.version_no DESC`,[companyIds])).rows;
  const result=new Map();
  for(const row of rows){const key=`${row.company_id}:${row.service_line}`,entry=result.get(key)||{versionNo:0,versionId:null,tenantId:row.tenant_id,canonicalService:row.canonical_service,profileId:row.profile_id,regionProfileVersionId:row.active_region_version_id||null};if(row.parameter_key&&row.version_id)entry[row.parameter_key]=row.new_value;if(row.parameter_key==="A08"&&row.version_id){entry.versionNo=Number(row.version_no);entry.versionId=row.version_id;if(row.active_region_version_id&&row.region_configuration_version_id===row.version_id)entry.structuredRegions=row.new_value}else if(!entry.versionId&&row.version_id&&Number(row.version_no)>=entry.versionNo){entry.versionNo=Number(row.version_no);entry.versionId=row.version_id}result.set(key,entry)}
  return result;
}

async function targetRows(client,tenderIds,scope={},contextBindings=[]){
  if(!tenderIds.length)return[];
  return (await client.query(`SELECT DISTINCT ON(t.id,r.company_id,eligible_lot.lot_key) t.*,r.company_id,eligible_lot.lot_key,canonical_lot.id canonical_lot_id,r.evaluation_version relevance_version,r.snapshot_sha256 relevance_snapshot,r.service_line,r.relevance_status,r.service_scope_gate,r.reason relevance_reason,c.legal_name,c.technical_key,c.sector_slug,c.sector_status,tv.id tender_version_id,tv.normalized_data,configuration_scope.tenant_id,configuration_scope.canonical_service,configuration_scope.profile_id
    FROM tender.tenders t
    JOIN tender.service_relevance_evaluations r ON r.tender_id=t.id AND r.primary_company=true AND r.relevance_status='RELEVANT' AND r.service_scope_gate='PASSED'
    JOIN tender.enterprise_company_links c ON c.company_id=r.company_id AND c.active=true
    JOIN tender.configuration_scopes configuration_scope ON configuration_scope.company_id=r.company_id AND configuration_scope.profile_id=c.tender_profile_id AND configuration_scope.canonical_service=CASE r.service_line WHEN 'facility-management' THEN 'facility_management' WHEN 'emergency-services' THEN 'emergency_services' ELSE r.service_line END
    JOIN LATERAL(SELECT id,normalized_data FROM tender.tender_versions WHERE tender_id=t.id ORDER BY version DESC LIMIT 1)tv ON true
    JOIN LATERAL(
      SELECT eligible.lot_key
      FROM tender.current_participation_eligible_lots eligible
      WHERE eligible.tender_id=t.id
        AND (r.lot_key IS NULL OR eligible.lot_key=r.lot_key)
      UNION
      SELECT selection.source_lot_id AS lot_key
      FROM tender.tender_lot_selections selection
      WHERE selection.tender_id=t.id
        AND selection.company_id=r.company_id
        AND selection.canonical_service=configuration_scope.canonical_service
        AND (r.lot_key IS NULL OR selection.source_lot_id=r.lot_key)
    ) eligible_lot ON true
    JOIN tender.lots canonical_lot ON canonical_lot.tender_id=t.id AND canonical_lot.external_id=eligible_lot.lot_key
    WHERE t.id=ANY($1::uuid[]) AND t.data_class='PUBLIC_REAL' AND t.source_lifecycle_status='ACTIVE' AND t.participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE')
      AND ($2::uuid IS NULL OR r.company_id=$2) AND ($3='' OR configuration_scope.canonical_service=$3)
      AND ($4::uuid IS NULL OR configuration_scope.tenant_id=$4) AND ($5::uuid IS NULL OR configuration_scope.profile_id=$5)
      AND ($6::jsonb IS NULL OR EXISTS(SELECT 1 FROM jsonb_to_recordset($6::jsonb) binding(tender_id uuid,company_id uuid,lot_key text)
        WHERE binding.tender_id=t.id AND binding.company_id=r.company_id AND binding.lot_key=eligible_lot.lot_key))
      AND NOT EXISTS(SELECT 1 FROM tender.service_relevance_evaluations newer WHERE newer.tender_id=r.tender_id AND newer.company_id=r.company_id AND newer.lot_key IS NOT DISTINCT FROM r.lot_key AND newer.evaluation_version>r.evaluation_version)
      AND NOT EXISTS(SELECT 1 FROM tender.tender_tombstones tomb WHERE tomb.source_code=t.source_code AND tomb.external_id=t.external_id AND tomb.tombstone_status='DELETED')
    ORDER BY t.id,r.company_id,eligible_lot.lot_key,r.evaluation_version DESC`,[tenderIds,scope.companyId||null,scope.canonicalService||"",scope.tenantId||null,scope.profileId||null,contextBindings.length?json(contextBindings):null])).rows;
}

async function existingDocuments(client,tenderId){return (await client.query(`SELECT d.fetch_status,d.resolution_status FROM tender.enrichment_documents d JOIN tender.enrichment_versions e ON e.id=d.enrichment_version_id WHERE e.tender_id=$1 AND e.historical=false`,[tenderId])).rows}

export async function runInboxPipeline(pool,{tenderIds=[],contextBindings=[],sourceRunId=null,runKind="SCHEDULED",cutoffAt=null,batchSize=100,scope=null,onProgress=null}={}){
  const exactBindings=normalizeExactContextBindings(contextBindings),ids=unique([...tenderIds,...exactBindings.map(binding=>binding.tender_id)]),lockClient=await pool.connect(),lock=(await lockClient.query("SELECT pg_try_advisory_lock(hashtext('wb-daily-inbox-pipeline')) acquired")).rows[0].acquired;
  if(!lock){lockClient.release();throw Object.assign(new Error("inbox pipeline lease already held"),{code:"INBOX_PIPELINE_LEASE_HELD"})}
  let runId,batchId,stats={checked:0,matched:0,inboxCreated:0,regionCreated:0,skipped:0,core:0,strategic:0,outside:0,unresolved:0,documentFailures:0};
  try{
    runId=(await pool.query("INSERT INTO tender.inbox_pipeline_runs(source_run_id,run_kind,status,cutoff_at,metadata) VALUES($1,$2,'RUNNING',$3,$4::jsonb) RETURNING id",[sourceRunId,runKind,cutoffAt,json({pipelineVersion:INBOX_PIPELINE_VERSION,batchSize})])).rows[0].id;
    const client=await pool.connect();
    try{
      const targets=await targetRows(client,ids,scope||{},exactBindings);
      if(exactBindings.length&&targets.length!==exactBindings.length)throw Object.assign(new Error("exact_context_binding_target_mismatch"),{code:"EXACT_CONTEXT_BINDING_TARGET_MISMATCH",expected:exactBindings.length,actual:targets.length});
      const configs=await loadConfiguration(client,unique(targets.map(row=>row.company_id))),configurationHash=hash([...configs.entries()]),inputHash=hash(targets.map(row=>[row.id,row.raw_sha256,row.relevance_snapshot]));
      const completedBatch=(await client.query("SELECT id FROM tender.region_evaluation_batches WHERE algorithm_version=$1 AND configuration_snapshot_sha256=$2 AND input_snapshot_sha256=$3 AND status='COMPLETED'",[INBOX_PIPELINE_VERSION,configurationHash,inputHash])).rows[0];
      batchId=completedBatch?.id||(await client.query("INSERT INTO tender.region_evaluation_batches(algorithm_version,configuration_snapshot_sha256,input_snapshot_sha256,status) VALUES($1,$2,$3,'RUNNING') RETURNING id",[INBOX_PIPELINE_VERSION,configurationHash,inputHash])).rows[0].id;
      for(let offset=0;offset<targets.length;offset+=Math.max(1,Math.min(500,Number(batchSize)||100))){
        await client.query("BEGIN");
        try{
          for(const row of targets.slice(offset,offset+Math.max(1,Math.min(500,Number(batchSize)||100)))){
            const locations=extractSourceLocations(row,row.normalized_data||{},row.lot_key),tender={...row,locations},company={company_id:row.company_id,legal_name:row.legal_name,technical_key:row.technical_key,sector_slug:row.sector_slug,sector_status:row.sector_status},config=configs.get(`${row.company_id}:${row.service_line}`)||{},region=classifyRegion({company,tender,config,applicable:true}),documents=await existingDocuments(client,row.id),documentStatus=documentPipelineStatus(documents),decision=inboxDecision(region),fingerprint=hash({pipeline:INBOX_PIPELINE_VERSION,tenderVersion:row.tender_version_id,relevance:row.relevance_snapshot,tenant:config.tenantId,company:row.company_id,lotId:row.canonical_lot_id,lotKey:row.lot_key,service:config.canonicalService,profile:config.profileId,activeVersion:config.versionId,regionProfileVersion:config.regionProfileVersionId,config:region.ruleSnapshot,locations:region.sourceData}),prior=(await client.query(`SELECT inbox.id,inbox.workflow_status,inbox.responsible_user_id FROM tender.region_evaluations prior_region JOIN tender.management_inbox inbox ON inbox.id=prior_region.inbox_id WHERE prior_region.tender_id=$1 AND prior_region.company_id=$2 AND prior_region.lot_id IS NOT DISTINCT FROM $3::uuid ORDER BY prior_region.evaluation_version DESC LIMIT 1`,[row.id,row.company_id,row.canonical_lot_id||null])).rows[0];
            const inserted=await client.query(`INSERT INTO tender.management_inbox(tender_id,tender_version_id,event_kind,tenant_id,company_id,sector_slug,service_line,canonical_service,profile_id,region_profile_version_id,decision,hard_gates,missing_information,risks,recommended_next_step,workflow_status,responsible_user_id,source_code,source_run_id,event_fingerprint)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,'[]'::jsonb,$14,$15,$16,$17,$18,$19)
              ON CONFLICT(event_fingerprint) DO NOTHING RETURNING id`,[row.id,row.tender_version_id,prior?"UPDATED":"NEW",config.tenantId,row.company_id,row.sector_slug,row.service_line,config.canonicalService,config.profileId,config.regionProfileVersionId,decision.decision,json(["EXCLUDED_REGION","OUTSIDE_CORE_REGION"].includes(region.classification)?[region.classification]:[]),json(documentStatus.includes("FAILED")?["DOCUMENT_DOWNLOAD_FAILED"]:["REGION_UNRESOLVED","MULTI_REGION_REVIEW","REGION_CONFIG_CONFLICT"].includes(region.classification)?["LOCATION_UNRESOLVED"]:[]),decision.next,prior?.workflow_status||"NEW",prior?.responsible_user_id||null,row.source_code,sourceRunId,fingerprint]);
            const inboxId=inserted.rows[0]?.id||(await client.query("SELECT id FROM tender.management_inbox WHERE event_fingerprint=$1",[fingerprint])).rows[0].id;
            const latest=(await client.query("SELECT id,source_data->>'pipelineFingerprint' fingerprint FROM tender.region_evaluations WHERE tender_id=$1 AND tenant_id=$2 AND company_id=$3 AND canonical_service=$4 AND profile_id=$5 AND lot_id IS NOT DISTINCT FROM $6::uuid ORDER BY evaluation_version DESC LIMIT 1",[row.id,config.tenantId,row.company_id,config.canonicalService,config.profileId,row.canonical_lot_id||null])).rows[0];
            let exactRegionEvaluationId=latest?.id||null;
            if(latest?.fingerprint!==fingerprint){
              const version=Number((await client.query("SELECT coalesce(max(evaluation_version),0)+1 version FROM tender.region_evaluations WHERE tender_id=$1 AND company_id=$2 AND lot_id IS NOT DISTINCT FROM $3::uuid",[row.id,row.company_id,row.canonical_lot_id])).rows[0].version);
              const created=await client.query(`INSERT INTO tender.region_evaluations(batch_id,tender_id,inbox_id,lot_id,tenant_id,company_id,canonical_service,profile_id,region_profile_version_id,evaluation_version,classification,detected_states,detected_nuts,source_data,parameter_key,configuration_version_id,configuration_version_no,rule_snapshot,regional_decision,matching_status,explanation,open_conditions,next_action)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,$18::jsonb,$19,$20,$21,$22::jsonb,$23) RETURNING id`,[batchId,row.id,inboxId,row.canonical_lot_id,config.tenantId,row.company_id,config.canonicalService,config.profileId,config.regionProfileVersionId,version,region.classification,json(region.detectedStates),json(region.nuts),json({...region.sourceData,pipelineVersion:INBOX_PIPELINE_VERSION,pipelineFingerprint:fingerprint}),region.parameterKey,region.configVersionId,region.configVersion,json(region.ruleSnapshot),region.decision,region.matchingStatus,region.reason,json(region.openConditions),region.nextAction]);
              exactRegionEvaluationId=created.rows[0]?.id||null;
              stats.regionCreated++;
            }
            if(row.canonical_lot_id&&exactRegionEvaluationId){
              await client.query(`UPDATE tender.tender_lot_selections SET region_evaluation_id=$1,updated_at=now()
                WHERE tenant_id=$2 AND company_id=$3 AND tender_id=$4 AND lot_id=$5 AND source_lot_id=$6
                  AND region_evaluation_id IS DISTINCT FROM $1`,[exactRegionEvaluationId,config.tenantId,row.company_id,row.id,row.canonical_lot_id,row.lot_key]);
            }
            await client.query(`INSERT INTO tender.inbox_pipeline_items(run_id,tender_id,company_id,lot_key,classification_status,region_status,document_status,matching_status,inbox_status,exclusion_reason,pipeline_fingerprint,location_evidence)
              VALUES($1,$2,$3,$4,'CLASSIFIED',$5,$6,'MATCHED',$7,$8,$9,$10::jsonb)`,[runId,row.id,row.company_id,row.lot_key||"",region.classification,documentStatus,inserted.rowCount?"CREATED":"UNCHANGED",decision.exclusion,fingerprint,json({states:region.detectedStates,nuts:region.nuts,hasPostalCode:locations.some(item=>Boolean(item.postalCode)),locationCount:locations.length})]);
            stats.checked++;stats.matched++;stats.inboxCreated+=inserted.rowCount;stats.documentFailures+=documentStatus.includes("FAILED")?1:0;if(region.classification==="CORE_REGION")stats.core++;else if(region.classification==="STRATEGIC_REGION")stats.strategic++;else if(region.classification==="OUTSIDE_CORE_REGION")stats.outside++;else stats.unresolved++;
          }
          await client.query("COMMIT");
          if(onProgress)await onProgress({processed:Math.min(offset+Math.max(1,Math.min(500,Number(batchSize)||100)),targets.length),total:targets.length,stats:{...stats}});
        }catch(error){await client.query("ROLLBACK");throw error}
      }
      await client.query("UPDATE tender.region_evaluation_batches SET status='COMPLETED',completed_at=now() WHERE id=$1",[batchId]);
    }finally{client.release()}
    // One tender can legitimately produce multiple company contexts. Skipped is
    // an input-tender metric and must therefore never become negative.
    stats.skipped=Math.max(0,ids.length-Math.min(ids.length,stats.checked));
    await pool.query("UPDATE tender.inbox_pipeline_runs SET status='SUCCESS',finished_at=now(),checked_count=$2,matched_count=$3,inbox_created_count=$4,region_created_count=$5,skipped_count=$6,metadata=metadata||$7::jsonb WHERE id=$1",[runId,stats.checked,stats.matched,stats.inboxCreated,stats.regionCreated,stats.skipped,json(stats)]);
    return{passed:true,runId,...stats};
  }catch(error){if(batchId)await pool.query("UPDATE tender.region_evaluation_batches SET status='FAILED',completed_at=now() WHERE id=$1",[batchId]).catch(()=>{});if(runId)await pool.query("UPDATE tender.inbox_pipeline_runs SET status='FAILED',finished_at=now(),error_count=1,error_code=$2 WHERE id=$1",[runId,String(error.code||"INBOX_PIPELINE_FAILED").slice(0,80)]).catch(()=>{});throw error
  }finally{await lockClient.query("SELECT pg_advisory_unlock(hashtext('wb-daily-inbox-pipeline'))").catch(()=>{});lockClient.release()}
}
