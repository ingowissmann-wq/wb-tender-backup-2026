import fs from "node:fs";
import pg from "pg";
import {createFixedScopedPool,loadBackgroundScope} from "../platform/scoped-pg-pool.mjs";

const targets=[
  {externalId:"540350-2026",companyName:"WB-Security GmbH",lotKey:"LOT-0000"},
  {externalId:"552392-2026",companyName:"WB-Cleaning GmbH",lotKey:"LOT-0000"},
];
const connectionString=process.env.DATABASE_URL||fs.readFileSync(process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8").trim();
const rawPool=new pg.Pool({connectionString,max:1,options:["-c default_transaction_read_only=on","-c statement_timeout=30000",process.env.DATABASE_SESSION_OPTIONS].filter(Boolean).join(" ")});
const fixed=createFixedScopedPool(rawPool,await loadBackgroundScope(rawPool));
const pool=fixed.pool;
const rows=[];
try{
  const safety=(await pool.query("SELECT external_submission_enabled,allow_external_submission,global_kill_switch FROM tender.submission_runtime_settings")).rows[0];
  if(safety?.external_submission_enabled||safety?.allow_external_submission||safety?.global_kill_switch!==true)throw new Error("submission_safety_not_locked");
  for(const target of targets){
    const discovered=(await pool.query(`SELECT context.company_id,company.legal_name
      FROM tender.tenders tender JOIN tender.pipeline_contexts context ON context.tender_id=tender.id
      JOIN tender.enterprise_company_links company ON company.company_id=context.company_id
      WHERE tender.external_id=$1 AND context.lot_key=$2 AND context.pipeline_version='wb-tender-pipeline/5.0.0'`,
      [target.externalId,target.lotKey])).rows;
    if(discovered.length!==1||discovered[0].legal_name!==target.companyName)throw new Error(`target_company_context_mismatch:${target.externalId}`);
    const companyId=discovered[0].company_id;
    const tender=(await pool.query(`SELECT id tender_id,notice_number,external_id FROM tender.tenders
      WHERE external_id=$1 AND data_class='PUBLIC_REAL' AND source_lifecycle_status='ACTIVE'
        AND participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE')`,[target.externalId])).rows[0];
    const scope=(await pool.query(`SELECT scope.tenant_id,scope.canonical_service,company.legal_name
      FROM tender.configuration_scopes scope JOIN tender.enterprise_company_links company
        ON company.company_id=scope.company_id AND company.tender_profile_id=scope.profile_id
      WHERE scope.company_id=$1`,[companyId])).rows;
    if(!tender||scope.length!==1)throw new Error(`canonical_base_context_missing:${target.externalId}`);
    const relevance=(await pool.query(`SELECT relevance.service_line,relevance.evaluation_version,relevance.relevance_status,
        relevance.service_scope_gate,relevance.recommendation,relevance.primary_company
      FROM tender.service_relevance_evaluations relevance
      WHERE relevance.tender_id=$1 AND relevance.company_id=$2 AND (relevance.lot_key=$3 OR relevance.lot_key IS NULL)
        AND NOT EXISTS(SELECT 1 FROM tender.service_relevance_evaluations newer
          WHERE newer.tender_id=relevance.tender_id AND newer.company_id=relevance.company_id
            AND newer.lot_key IS NOT DISTINCT FROM relevance.lot_key AND newer.evaluation_version>relevance.evaluation_version)
      ORDER BY (relevance.lot_key IS NOT DISTINCT FROM $3) DESC,relevance.evaluation_version DESC LIMIT 1`,
      [tender.tender_id,companyId,target.lotKey])).rows[0];
    const components=(await pool.query(`SELECT version.id tender_version_id,lot.id lot_id,selection.lot_id selected_lot_id,
        enrichment.id enrichment_version_id,enrichment.version enrichment_version,binding.id enrichment_context_binding_id,
        context.context_integrity_status,context.lot_id pipeline_lot_id,context.enrichment_version_id pipeline_enrichment_version_id,
        document_resolution.portal_id document_portal_id,document_portal.canonical_domain document_portal_domain,
        submission_resolution.portal_id submission_portal_id,submission_portal.canonical_domain submission_portal_domain
      FROM tender.lots lot
      JOIN LATERAL(SELECT candidate.id FROM tender.tender_versions candidate WHERE candidate.tender_id=lot.tender_id ORDER BY candidate.version DESC LIMIT 1)version ON true
      JOIN tender.tender_lot_selections selection ON selection.tenant_id=$3 AND selection.company_id=$2
        AND selection.tender_id=lot.tender_id AND selection.source_lot_id=lot.external_id AND selection.lot_id=lot.id
      JOIN LATERAL(SELECT candidate.id,candidate.version FROM tender.enrichment_versions candidate
        JOIN tender.enrichment_context_bindings candidate_binding ON candidate_binding.enrichment_version_id=candidate.id
        WHERE candidate.tender_id=lot.tender_id AND candidate.historical=false AND candidate_binding.tenant_id=$3
          AND candidate_binding.company_id=$2 AND candidate_binding.lot_id=lot.id AND candidate_binding.source_lot_id=lot.external_id
        ORDER BY candidate.version DESC LIMIT 1)enrichment ON true
      JOIN tender.enrichment_context_bindings binding ON binding.enrichment_version_id=enrichment.id AND binding.tenant_id=$3
        AND binding.company_id=$2 AND binding.tender_id=lot.tender_id AND binding.lot_id=lot.id AND binding.source_lot_id=lot.external_id
      JOIN tender.pipeline_contexts context ON context.tenant_id=$3 AND context.company_id=$2
        AND context.tender_id=lot.tender_id AND context.lot_key=lot.external_id AND context.pipeline_version='wb-tender-pipeline/5.0.0'
      JOIN tender.tender_portal_resolutions document_resolution ON document_resolution.tender_id=lot.tender_id
        AND document_resolution.evidence_role='PROCUREMENT_DOCUMENT'
      JOIN tender.portal_registry document_portal ON document_portal.id=document_resolution.portal_id
      JOIN tender.tender_portal_resolutions submission_resolution ON submission_resolution.tender_id=lot.tender_id
        AND submission_resolution.evidence_role='SUBMISSION'
      JOIN tender.portal_registry submission_portal ON submission_portal.id=submission_resolution.portal_id
      WHERE lot.tender_id=$1 AND lot.external_id=$4`,[tender.tender_id,companyId,scope[0].tenant_id,target.lotKey])).rows[0];
    const result=tender&&relevance&&components?{...tender,...scope[0],...relevance,...components,effective_lot_key:target.lotKey}:null;
    if(!result)throw new Error(`canonical_action_context_missing:${target.externalId}`);
    const required=["tender_id","tender_version_id","lot_id","enrichment_version_id","evaluation_version","service_line"];
    const missing=required.filter(key=>result[key]===null||result[key]===undefined||result[key]==="");
    if(missing.length)throw new Error(`action_context_incomplete:${target.externalId}:${missing.join(",")}`);
    if(String(result.lot_id)!==String(result.selected_lot_id)||String(result.lot_id)!==String(result.pipeline_lot_id))throw new Error(`lot_identity_mismatch:${target.externalId}`);
    if(String(result.enrichment_version_id)!==String(result.pipeline_enrichment_version_id))throw new Error(`enrichment_identity_mismatch:${target.externalId}`);
    if(result.context_integrity_status!=="CANONICAL")throw new Error(`pipeline_context_not_canonical:${target.externalId}`);
    if(result.document_portal_domain!=="vergabe.muenchen.de"||result.submission_portal_domain!=="vergabe.muenchen.de")throw new Error(`munich_portal_resolution_mismatch:${target.externalId}`);
    const documents=(await pool.query(`SELECT id,filename,source_url,document_type,fetch_status,resolution_status,http_status,
        mime_type,content_size,payload_sha256,procurement_verification_status,parser,parser_version,retrieved_at,
        tender_association_verified,lot_association_verified,magic_bytes_verified,
        coalesce(provenance->>'malwareScanStatus','') malware_scan_status
      FROM tender.enrichment_documents WHERE enrichment_version_id=$1 ORDER BY created_at,id`,[result.enrichment_version_id])).rows;
    const jobs=(await pool.query(`SELECT id,action_type,status,current_step,next_step,documents_found,documents_downloaded,
        documents_analyzed,document_resolution_status,error_code,error_detail_safe,blocking_reason,terminal_result,
        result_summary,created_at,finished_at
      FROM tender.autopilot_queue WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3 ORDER BY created_at DESC LIMIT 10`,
      [result.tender_id,companyId,target.lotKey])).rows;
    const registeredScopes=(await pool.query(`SELECT portal_id,credential_id,active_credential_count,mapping_status
      FROM tender.current_tender_company_portal_credential_scopes WHERE tender_id=$1 AND company_id=$2
      ORDER BY portal_id,credential_id`,[result.tender_id,companyId])).rows;
    const allDocumentAttempts=(await pool.query(`SELECT enrichment.version enrichment_version,document.id,document.source_url,
        document.fetch_status,document.resolution_status,document.http_status,document.mime_type,document.content_size,
        document.payload_sha256,document.procurement_verification_status,document.provenance->>'error' safe_error,
        document.provenance->>'targetPortal' target_portal,document.retrieved_at
      FROM tender.enrichment_versions enrichment JOIN tender.enrichment_documents document ON document.enrichment_version_id=enrichment.id
      WHERE enrichment.tender_id=$1 ORDER BY enrichment.version,document.created_at,document.id`,[result.tender_id])).rows;
    rows.push({...result,missingContext:[],documents,allDocumentAttempts,jobs,registeredScopes,externalWrite:false,transmitted:false});
  }
  console.log(JSON.stringify({mode:"READ_ONLY",verified:true,safety,contexts:rows,externalWrite:false,transmitted:false},null,2));
}finally{await rawPool.end()}
