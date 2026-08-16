import crypto from "node:crypto";

export const managementInboxSavedActionsSql = `SELECT ae.action,ae.occurred_at AS created_at FROM tender.audit_events ae WHERE ae.actor_id=$1 AND ae.tender_id=$2
  AND ae.metadata->>'company_id'=$3 AND coalesce(ae.metadata->>'lot_key','')=$4
  AND ae.action IN('favorite','task_created','internal_deadline_adopted','reminder_created') ORDER BY ae.occurred_at DESC LIMIT 20`;

export const canonicalCalculationStatus = (row) => {
  if (row.management_status === "CALCULATION_BLOCKED_MISSING_FACILITY_PROFILE")
    return "CALCULATION_BLOCKED_MISSING_FACILITY_PROFILE";
  if (row.calculation_result_status)
    return row.calculation_result_status === "CALCULATION_COMPLETED"
      ? "CALCULATED"
      : row.calculation_result_status;
  if (["QUEUED", "RETRY_WAIT"].includes(row.pipeline_status))
    return row.pipeline_status === "RETRY_WAIT"
      ? "CALCULATION_FAILED_RETRYING"
      : "CALCULATION_QUEUED";
  if (["CLAIMED", "RUNNING"].includes(row.pipeline_status))
    return "CALCULATING";
  if (row.pipeline_calculation_status)
    return row.pipeline_calculation_status === "CALCULATION_COMPLETED"
      ? "CALCULATED"
      : row.pipeline_calculation_status;
  const canonical = row.canonical_calculation_status;
  if (canonical) return canonical;
  if (row.management_status === "NICHT_KALKULIERBAR_FEHLENDE_TENDERUNTERLAGEN")
    return "CALCULATION_BLOCKED_MISSING_INPUT";
  if (row.management_status === "DOCUMENTS_NOT_AVAILABLE")
    return "CALCULATION_BLOCKED_DOCUMENTS_NOT_AVAILABLE";
  if (row.management_status) return "TECHNICAL_STATUS_ERROR";
  return "NOT_STARTED";
};
import { boardBrief, evaluateGoNoGo, matchTender } from "./autopilot-core.mjs";
import {
  buildRequirementMatrix,
  extractRequirements,
  validateDocument,
} from "./document-analysis.mjs";
import { calculateScenario, sensitivity } from "./calculation.mjs";
import { prepareDocument } from "./offer-documents.mjs";
import {
  prepareExternalAction,
  validatePortalAdapter,
} from "./portal-approval.mjs";
import { parseBinaryDocumentIsolated } from "./parser-sandbox.mjs";
import { generateDocument } from "./document-generators.mjs";
import { buildFullTenderReview } from "./full-tender-review.mjs";
import { unique } from "./service-relevance.mjs";
import {
  canonicalPortalUrl,
  decryptSecret,
  encryptSecret,
  maskUsername,
  portalAccessCapabilities,
  publicCredential,
  testReadOnlyPortal,
} from "./portal-credentials.mjs";
import { portalLoginAction } from "./portal-login-action.mjs";
import { PIPELINE_SCHEMA_VERSION, PIPELINE_STEPS } from "./canonical-truth.mjs";
import { adapterCoverageMatrix } from "./portal-adapter-catalog.mjs";
import {
  approvalBinding,
  BID_APPROVAL_CONFIRMATION_PHRASE,
  evaluateSubmissionGate,
  manifestHash,
} from "./bid-workflow.mjs";
import { buildCalculationViewModel } from "./calculation-view-model.mjs";
import { generateBidPackageDocuments } from "./bid-package-documents.mjs";
import {
  approvedPackageBinding,
  packageResolution,
} from "./bid-package-binding.mjs";
import {
  evaluateEnterprisePreflight,
  submissionFingerprint,
  submissionHash,
} from "./submission-framework.mjs";
import { submissionAdapters } from "./submission-adapters.mjs";
import {
  inspectUploadedDocument,
  requirementLabel,
  submissionDocumentsComplete,
} from "./required-documents.mjs";
import { inspectSignedPdf, prepareSignatureCopy } from "./signature-workbench.mjs";
import { scanBuffer, scannerHealth } from "./malware-scanner.mjs";
import {
  discoverSourceRequirements,
  evaluatePackageReadiness,
  explicitDocumentLotKeys,
  extractPages,
} from "./generic-final-preflight.mjs";
import {
  buildOperationsKpis,
  learnFromRealOutcomes,
  prioritizeOperationsCandidates,
} from "./operations-revenue-engine.mjs";
import { mayView } from "./auth.mjs";
import { enqueueVerifiedSessionFanout } from "./verified-session-fanout.mjs";
import { deriveDocumentWorkflowTruth } from "./document-workflow-truth.mjs";
import { hasExactOriginalFormProvenance, resolveRequiredOriginalForm, safeOriginalFilename } from "./required-form-mapping.mjs";
import { resolveRequiredSourceDocument } from "./required-source-mapping.mjs";
import { saveFavorite } from "./favorites.mjs";
import { decorateSubmissionBlockers } from "./submission-blocker-actions.mjs";
import { evaluateManagementApprovalTruth, managementApprovalBlocker } from "./management-approval-truth.mjs";
import { validateExplicitCalculationInput } from "./calculation-input-contract.mjs";
import { internalPreparationReadiness } from "./internal-preparation-readiness.mjs";
import { buildDocumentWorkbench, documentInScope } from "./document-workbench.mjs";
import { capabilityState, PRODUCT_BOUNDARY, readinessGate } from "./product-readiness.mjs";
import { canonicalPackageManifest, monitoringEventPresentation, normalizeInboundEvent } from "./submission-orchestrator.mjs";
import { authorizeBindingReleaseApproval, effectiveBindingRelease, validateBindingReleaseRequest } from "./binding-action-release.mjs";
import { requireRegisteredTenderPortalScope } from "./registered-portal-scope.mjs";

export function registerAutopilotRoutes(
  app,
  { pool, requirePermission, csrf, visibleTender },
) {
  const read = requirePermission("tender.view_assigned");
  const validUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value||""));
  const scoped = (identity, row) =>
    identity.permissions.includes("tender.admin") ||
    ((!row.company_id ||
      identity.companyIds.includes(String(row.company_id))) &&
      (!row.sector_slug ||
        identity.sectorSlugs.includes(String(row.sector_slug))));
  const accessibleCompanies = async (identity) =>
    (
      await pool.query(
        "SELECT company_id,legal_name,COALESCE(sector_slug,technical_key) service_line,sector_slug FROM tender.enterprise_company_links ORDER BY legal_name",
      )
    ).rows.filter(
      (row) =>
        identity.permissions.includes("tender.admin") ||
        identity.companyIds.includes(String(row.company_id)),
    );
  const requireRegisteredScope = (reply, tenderId, companyId) =>
    requireRegisteredTenderPortalScope(pool, reply, { tenderId, companyId });
  const requireQueryCompanyScope = async (req, reply, tenderId) => {
    const companies = await accessibleCompanies(req.identity);
    const company = companies.find(
      (row) => String(row.company_id) === String(req.query?.company || ""),
    );
    if (!company) {
      reply.code(403).send({ error: "company_scope_forbidden" });
      return null;
    }
    return requireRegisteredScope(reply, tenderId, company.company_id);
  };

  app.get("/api/product-readiness", { preHandler: read }, async (req) => {
    const companies = await accessibleCompanies(req.identity);
    const companyIds = companies.map((company) => company.company_id);
    const rows = (await pool.query(`
      SELECT portal.id portal_id,portal.display_name portal_name,portal.canonical_domain,
             portal.adapter_id,portal.adapter_enabled,tender.canonical_portal_adapter_validation_status(portal.adapter_validation_status) adapter_validation_status,
             feature.feature_key,feature.portal_support,feature.autopilot_supported,
             feature.actively_configured,feature.production_tested,
             feature.browser_acceptance_passed,feature.verified_at,feature.evidence_note,
             EXISTS(
               SELECT 1 FROM tender.portal_credential_secrets credential
               JOIN tender.portal_credential_companies scope ON scope.credential_id=credential.id AND scope.active=true
               WHERE credential.portal_id=portal.id AND credential.status='ACTIVE'
                 AND ($1::boolean OR scope.company_id=ANY($2::uuid[]))
             ) credential_configured
        FROM tender.portal_registry portal
        LEFT JOIN LATERAL(
          SELECT profile.id FROM tender.portal_capability_profiles profile
           WHERE profile.portal_id=portal.id ORDER BY profile.profile_version DESC LIMIT 1
        ) current_profile ON true
        LEFT JOIN tender.portal_capability_features feature ON feature.profile_id=current_profile.id
       WHERE portal.adapter_enabled=true OR EXISTS(
         SELECT 1 FROM tender.portal_credential_secrets credential
          WHERE credential.portal_id=portal.id AND credential.status='ACTIVE'
       )
       ORDER BY portal.display_name,feature.feature_key`, [req.identity.permissions.includes("tender.admin"), companyIds])).rows;
    const byPortal = new Map();
    for (const row of rows) {
      if (!byPortal.has(row.portal_id)) byPortal.set(row.portal_id, {
        portalId: row.portal_id,
        portalName: row.portal_name,
        domain: row.canonical_domain,
        adapterId: row.adapter_id,
        adapterEnabled: row.adapter_enabled,
        adapterValidationStatus: row.adapter_validation_status,
        credentialConfigured: row.credential_configured,
        features: {},
      });
      if (row.feature_key) byPortal.get(row.portal_id).features[row.feature_key] = capabilityState(row);
    }
    const portals = [...byPortal.values()];
    const transmittedColumns = (await pool.query(`SELECT table_name FROM information_schema.columns
      WHERE table_schema='tender' AND column_name='transmitted' ORDER BY table_name`)).rows;
    let transmittedTrue = 0;
    for (const { table_name: tableName } of transmittedColumns) {
      if (!/^[a-z][a-z0-9_]*$/.test(tableName)) throw new Error("unsafe_transmitted_table_name");
      transmittedTrue += Number((await pool.query(`SELECT count(*) count FROM tender.${tableName} WHERE transmitted IS TRUE`)).rows[0].count);
    }
    return {
      generatedAt: new Date().toISOString(),
      scope: PRODUCT_BOUNDARY,
      gate: readinessGate({ transmittedTrue, portals }),
      safety: {
        EXTERNAL_SUBMISSION_ENABLED: false,
        WB_TENDER_ALLOW_EXTERNAL_SUBMISSION: false,
        external_submission_enabled: false,
        transmitted: false,
        transmittedTrue,
      },
      portals,
    };
  });
  const requiredDocumentContext = async (tenderId, companyId, lotKey = "") => {
    await pool.query(`WITH matches AS(
      SELECT r.id required_document_id,e.id evidence_item_id
      FROM tender.required_documents r JOIN tender.evidence_items e ON e.company_id=r.company_id
      WHERE r.tender_id=$1 AND r.company_id=$2 AND r.lot_key=$3 AND r.reusable_company_evidence=true
        AND r.satisfaction_status IN('MISSING','AVAILABLE') AND e.status IN('VERIFIED','VALIDATED','AVAILABLE')
        AND (e.valid_until IS NULL OR e.valid_until>=current_date)
        AND (upper(e.evidence_type)=upper(r.document_type) OR upper(e.evidence_type)=upper(r.category))
    ), linked AS(
      INSERT INTO tender.required_document_company_evidence_links(required_document_id,evidence_item_id,matched_by)
      SELECT required_document_id,evidence_item_id,'VERIFIED_COMPANY_EVIDENCE_EXACT_TYPE' FROM matches ON CONFLICT DO NOTHING RETURNING required_document_id
    ) UPDATE tender.required_documents r SET satisfaction_status='VALIDATED',source_type='COMPANY_EVIDENCE',updated_at=now()
      WHERE r.id IN(SELECT required_document_id FROM matches)`,[tenderId,companyId,lotKey]);
    const rows = (await pool.query(`SELECT r.*,u.filename,u.media_type,u.size_bytes,u.sha256,u.version upload_version,
      u.validation_status upload_validation_status,u.validation_summary,u.validation_details,u.uploaded_at,u.reviewed_at,
      p.id package_binding_id,p.bid_package_id,p.portal_upload_category mapped_portal_category,p.portal_field_id mapped_portal_field,
      source.id original_document_id,source.filename original_filename,source.mime_type original_mime_type,
      source.payload_sha256 original_sha256,source.content original_content,source.procurement_verification_status original_verification_status,
      source.provenance original_provenance,source_version.version original_document_version,source_version.tender_id original_tender_id
      FROM tender.required_documents r
      LEFT JOIN tender.required_document_uploads u ON u.id=r.current_upload_id
      LEFT JOIN LATERAL(SELECT x.* FROM tender.required_document_package_bindings x WHERE x.required_document_id=r.id AND x.upload_id=u.id ORDER BY x.created_at DESC LIMIT 1)p ON true
      LEFT JOIN tender.enrichment_documents source ON source.id=r.source_document_id
      LEFT JOIN tender.enrichment_versions source_version ON source_version.id=source.enrichment_version_id
      WHERE r.tender_id=$1 AND r.company_id=$2 AND r.lot_key=$3 ORDER BY r.mandatory DESC,r.requirement_title`,
      [tenderId,companyId,lotKey])).rows;
    return rows.map((row)=>{
      const source=resolveRequiredSourceDocument(row,row.original_document_id?[{
        id:row.original_document_id,tender_id:row.original_tender_id,required_document_id:row.id,
        company_id:row.company_id,lot_key:row.lot_key,filename:row.original_filename,mime_type:row.original_mime_type,
        payload_sha256:row.original_sha256,content:row.original_content,document_version:row.original_document_version,
      }]:[]);
      const form=resolveRequiredOriginalForm(row,row.original_document_id?[{
        id:row.original_document_id,tender_id:row.original_tender_id,company_id:row.company_id,lot_key:row.lot_key,
        filename:row.original_filename,mime_type:row.original_mime_type,payload_sha256:row.original_sha256,
        content:row.original_content,procurement_verification_status:row.original_verification_status,
        document_version:row.original_document_version,explicit_form_mapping:hasExactOriginalFormProvenance(row,row.original_provenance),
      }]:[]);
      const result={...row,status_label:requirementLabel(row.satisfaction_status),source_document:{
        status:source.status,available:source.available,documentId:source.documentId||null,
        documentVersion:source.documentVersion||null,page:source.page||null,filename:source.filename||null,
        mimeType:source.mimeType||null,sha256:source.sha256||null,
      },original_form:{
        status:form.status,downloadable:form.downloadable,editable:form.editable,documentId:form.documentId||null,
        documentVersion:form.documentVersion||null,page:form.page||null,filename:form.candidate?.filename||null,
        mimeType:form.mimeType||null,sha256:form.sha256||null,
      }};
      delete result.original_content;delete result.original_provenance;
      return result;
    });
  };
  const runRequiredDocumentRecheck = async (client, requirement, upload, actorId) => {
    const requirements=(await client.query("SELECT * FROM tender.required_documents WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3 AND satisfaction_status<>'SUPERSEDED'",[requirement.tender_id,requirement.company_id,requirement.lot_key])).rows,
      complete=submissionDocumentsComplete(requirements),
      packageRow=(await client.query(`SELECT bp.* FROM tender.bid_packages bp JOIN tender.calculations c ON c.id=bp.calculation_id
        WHERE bp.tender_id=$1 AND c.company_id=$2 AND bp.lot_key=$3 ORDER BY bp.version DESC LIMIT 1`,[requirement.tender_id,requirement.company_id,requirement.lot_key])).rows[0],
      portalMappingStatus=requirement.portal_upload_category ? "MAPPED" : "MAPPING_REQUIRED";
    if(upload?.validation_status==="VALIDATED" && packageRow) await client.query(`INSERT INTO tender.required_document_package_bindings(required_document_id,upload_id,bid_package_id,binding_type,portal_upload_category,portal_field_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(upload_id,bid_package_id) DO NOTHING`,[requirement.id,upload.id,packageRow.id,requirement.approval_relevant?"NEW_PACKAGE_REVISION_REQUIRED":"SUPPLEMENTAL_EVIDENCE",requirement.portal_upload_category,requirement.portal_field_id,actorId]);
    const gateStatus=complete?"RECHECK_PASSED_REQUIRED_DOCUMENTS":"BLOCKED_REQUIRED_DOCUMENTS";
    if(requirement.satisfaction_status==="VALIDATED"){
      const linked=(await client.query(`UPDATE tender.final_preflight_requirements f SET status='VALIDATED',updated_at=now() FROM tender.final_preflight_contexts c
        WHERE f.context_id=c.id AND c.is_current AND c.tender_id=$1 AND c.company_id=$2 AND c.lot_key=$3 AND f.requirement_key=$4 RETURNING f.id`,[requirement.tender_id,requirement.company_id,requirement.lot_key,requirement.requirement_code])).rows;
      if(linked.length)await client.query("UPDATE tender.final_preflight_user_actions SET status='COMPLETED',completed_by=$2,completed_at=now(),updated_at=now() WHERE requirement_id=ANY($1::uuid[]) AND status IN('OPEN','IN_PROGRESS')",[linked.map(x=>x.id),actorId]);
      await client.query(`UPDATE tender.final_preflight_contexts c SET readiness_status=CASE WHEN NOT EXISTS(SELECT 1 FROM tender.final_preflight_requirements f WHERE f.context_id=c.id AND f.status NOT IN('VALIDATED','NOT_REQUIRED','SUPERSEDED')) AND $4 THEN 'MANAGEMENT_REVIEW_REQUIRED' ELSE readiness_status END,updated_at=now()
        WHERE c.is_current AND c.tender_id=$1 AND c.company_id=$2 AND c.lot_key=$3`,[requirement.tender_id,requirement.company_id,requirement.lot_key,complete]);
    }
    await client.query(`INSERT INTO tender.required_document_rechecks(required_document_id,trigger_upload_id,required_document_status,bid_package_status,portal_mapping_status,submission_gate_status,details)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[requirement.id,upload?.id||null,requirement.satisfaction_status,packageRow?(requirement.approval_relevant?"NEW_PACKAGE_REVISION_REQUIRED":"SUPPLEMENT_BOUND_TO_IMMUTABLE_PACKAGE"):"BID_PACKAGE_NOT_AVAILABLE",portalMappingStatus,gateStatus,JSON.stringify({pipeline:["REQUIRED_DOCUMENT_RECHECK","BID_PACKAGE_RECHECK","PORTAL_MAPPING_RECHECK","SUBMISSION_GATE_RECHECK"],allMandatorySubmissionDocumentsComplete:complete,externalSubmission:false,transmitted:false})]);
    await client.query("INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'REQUIRED_DOCUMENT_RECHECK_COMPLETED',$2,$3::jsonb)",[actorId,requirement.tender_id,JSON.stringify({requiredDocumentId:requirement.id,uploadId:upload?.id||null,gateStatus,portalMappingStatus,bidPackageId:packageRow?.id||null,transmitted:false})]);
    return {complete,gateStatus,portalMappingStatus,bidPackageId:packageRow?.id||null};
  };
  const reconcileDocumentRetries = async () => {
    const client=await pool.connect();try{await client.query("BEGIN");
      if(!(await client.query("SELECT pg_try_advisory_xact_lock(hashtext('tender-document-auto-retry-v1')) locked")).rows[0].locked){await client.query("ROLLBACK");return {enqueued:0}}
      const inserted=(await client.query(`WITH operational_context AS(
        SELECT r.tender_id,r.lot_key,r.company_id,r.service_line service_scope,r.evaluation_version assessment_version_id,
          tv.id tender_version_id,ev.id enrichment_version_id,pcx.current_step workflow_step,pcx.blocking_state workflow_blocking_state,
          portal.id portal_id,credential.id credential_id,credential.version credential_version,session.id retry_session_id,
          prior.id prior_job_id,prior.notice_id,prior.lot_id,prior.configuration_version_id,prior.max_attempts,prior.created_by,
          prior.status prior_status,prior.finished_at prior_finished_at,prior.document_resolution_status,prior.portal_access_status,
          prior.documents_found,prior.documents_downloaded,prior.documents_analyzed,prior.current_step prior_current_step
        FROM tender.current_service_relevance r
        JOIN tender.tenders t ON t.id=r.tender_id AND t.data_class='PUBLIC_REAL' AND t.offer_deadline>now()
        JOIN LATERAL(SELECT v.id FROM tender.tender_versions v WHERE v.tender_id=t.id ORDER BY v.version DESC LIMIT 1)tv ON true
        JOIN LATERAL(SELECT e.id FROM tender.enrichment_versions e WHERE e.tender_id=t.id AND e.historical=false ORDER BY e.version DESC LIMIT 1)ev ON true
        JOIN tender.current_registered_tender_company_portals registered ON registered.tender_id=t.id AND registered.company_id=r.company_id
        JOIN tender.portal_registry portal ON portal.id=registered.portal_id
        JOIN tender.portal_credential_secrets credential ON credential.id=registered.credential_id
        JOIN LATERAL(SELECT s.* FROM tender.portal_read_sessions s WHERE s.portal_id=portal.id AND s.credential_id=credential.id AND s.company_id=r.company_id AND tender.portal_session_effective_status(s.status,s.expires_at,s.revoked_at,s.verification_status)='ACTIVE' AND s.last_verified_at IS NOT NULL AND coalesce(s.cookie_count,0)>0 ORDER BY s.last_verified_at DESC LIMIT 1)session ON true
        LEFT JOIN tender.pipeline_contexts pcx ON pcx.tender_id=t.id AND pcx.company_id=r.company_id AND pcx.lot_key=coalesce(r.lot_key,'') AND pcx.pipeline_version='wb-tender-pipeline/5.0.0'
        LEFT JOIN LATERAL(SELECT q.* FROM tender.autopilot_queue q WHERE q.tender_id=t.id AND q.company_id=r.company_id AND q.lot_key IS NOT DISTINCT FROM r.lot_key AND q.action_type='RUN_FULL_PIPELINE' ORDER BY q.created_at DESC LIMIT 1)prior ON true
        WHERE r.primary_company=true AND r.relevance_status='RELEVANT' AND r.service_scope_gate='PASSED'
      ), eligible AS(
        SELECT o.* FROM operational_context o
        WHERE coalesce(o.workflow_blocking_state,'') IN('PROCUREMENT_DOCUMENTS_NOT_VERIFIED','UNKNOWN_PORTAL_ADAPTER_REQUIRED','PORTAL_ACCESS_REQUIRED','DOWNLOADLINK_NICHT_AUFGELOEST','SESSION_NICHT_FUER_DOWNLOAD_GUELTIG')
          AND NOT (o.prior_current_step='COMPLETED' AND coalesce(o.documents_found,0)>0
            AND coalesce(o.documents_downloaded,0)>=o.documents_found AND coalesce(o.documents_analyzed,0)>=o.documents_found)
          AND (o.prior_job_id IS NULL OR o.prior_status IN('DONE','SUCCEEDED','FAILED','DEAD_LETTER','CANCELLED'))
          AND NOT EXISTS(SELECT 1 FROM tender.autopilot_queue active WHERE active.tender_id=o.tender_id AND active.company_id=o.company_id AND active.lot_key IS NOT DISTINCT FROM o.lot_key AND active.action_type='RUN_FULL_PIPELINE' AND active.status IN('PENDING','CLAIMED','RETRY','QUEUED','RUNNING'))
          AND (o.prior_finished_at IS NULL OR o.retry_session_id IS NOT NULL AND (SELECT last_verified_at FROM tender.portal_read_sessions WHERE id=o.retry_session_id)>o.prior_finished_at)
      )
      INSERT INTO tender.autopilot_queue(request_id,action_type,tender_id,tender_version_id,notice_id,lot_id,lot_key,company_id,service_scope,portal_id,credential_id,enrichment_version_id,assessment_version_id,configuration_version_id,idempotency_key,reason,status,current_step,next_step,next_attempt_at,max_attempts,created_by)
      SELECT gen_random_uuid(),'RUN_FULL_PIPELINE',e.tender_id,e.tender_version_id,e.notice_id,e.lot_id,e.lot_key,e.company_id,e.service_scope,e.portal_id,e.credential_id,e.enrichment_version_id,e.assessment_version_id,e.configuration_version_id,
        'AUTO_SESSION_DOCUMENT_RETRY:'||coalesce(e.prior_job_id::text,'NEW')||':'||e.retry_session_id||':CREDV'||e.credential_version||':TV'||e.tender_version_id||':EV'||e.enrichment_version_id||':WF'||coalesce(e.workflow_step,'NEW'),
        'Gültige Portalsitzung erkannt; Dokumentworkflow wird automatisch fortgesetzt.','QUEUED','DOWNLOAD_LINK_RESOLUTION','DOCUMENT_DOWNLOAD',now(),coalesce(e.max_attempts,3),e.created_by
      FROM eligible e ON CONFLICT DO NOTHING RETURNING id,tender_id,company_id,lot_key`)).rows;
      for(const row of inserted)await client.query("INSERT INTO tender.audit_events(action,tender_id,metadata) VALUES('DOCUMENT_RETRY_AUTO_ENQUEUED',$1,$2::jsonb)",[row.tender_id,JSON.stringify({jobId:row.id,companyId:row.company_id,lotKey:row.lot_key,trigger:'VALID_PORTAL_SESSION',externalSubmission:false})]);
      await client.query("COMMIT");return {enqueued:inserted.length,items:inserted};
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
  };
  const retryTimer=setInterval(()=>reconcileDocumentRetries().catch((error)=>app.log.error({error:error.message},"automatic document retry reconciliation failed")),15000);
  retryTimer.unref?.();setTimeout(()=>reconcileDocumentRetries().catch((error)=>app.log.error({error:error.message},"initial document retry reconciliation failed")),1000).unref?.();
  app.addHook("onClose",async()=>clearInterval(retryTimer));
  const reconcileFinalPreflight = async ({ tenderId = null, limit = 500 } = {}) => {
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      if(!(await client.query("SELECT pg_try_advisory_xact_lock(hashtext('generic-final-preflight-v1')) locked")).rows[0].locked){await client.query("ROLLBACK");return {processed:0,locked:true}}
      const contexts=(await client.query(`SELECT r.tender_id,coalesce(r.lot_key,'') lot_key,r.company_id,r.service_line,t.offer_deadline,
        tv.id tender_version_id,
        calc.id calculation_id,mo.id management_output_id,approval.id approval_request_id,bp.id bid_package_id,sc.id submission_context_id,sc.portal_session_id,profile.id company_profile_id,
        coalesce(bp.document_revision_sha256,ev.payload_sha256) document_revision_sha256,f.schema_version prior_schema_version,
        coalesce((calc.id IS NOT NULL AND mo.calculation_id=calc.id AND bp.calculation_id=calc.id AND bp.management_output_id=mo.id
          AND bp.tender_version_id=tv.id AND (approval.id IS NULL OR approval.calculation_id=calc.id)
          AND (sc.id IS NULL OR (sc.bid_package_id=bp.id AND sc.approval_request_id=approval.id AND sc.transmitted=false))),false) binding_valid
      FROM tender.current_service_relevance r JOIN tender.tenders t ON t.id=r.tender_id
      JOIN LATERAL(SELECT * FROM tender.tender_versions x WHERE x.tender_id=r.tender_id ORDER BY x.version DESC LIMIT 1)tv ON true
      LEFT JOIN LATERAL(SELECT * FROM tender.enrichment_versions x WHERE x.tender_id=r.tender_id AND x.historical=false ORDER BY x.version DESC LIMIT 1)ev ON true
      LEFT JOIN LATERAL(SELECT * FROM tender.calculations x WHERE x.tender_id=r.tender_id AND x.company_id=r.company_id AND x.lot_key=coalesce(r.lot_key,'') ORDER BY x.version DESC LIMIT 1)calc ON true
      LEFT JOIN LATERAL(SELECT * FROM tender.management_outputs x WHERE x.tender_id=r.tender_id AND x.company_id=r.company_id AND x.lot_key=coalesce(r.lot_key,'') AND x.historical=false ORDER BY x.management_output_version DESC,x.created_at DESC LIMIT 1)mo ON true
      LEFT JOIN LATERAL(SELECT * FROM tender.approval_requests x WHERE x.tender_id=r.tender_id AND x.calculation_id=calc.id ORDER BY x.created_at DESC LIMIT 1)approval ON true
      LEFT JOIN LATERAL(SELECT * FROM tender.bid_packages x WHERE x.tender_id=r.tender_id AND x.calculation_id=calc.id AND x.lot_key=coalesce(r.lot_key,'') AND x.superseded_at IS NULL ORDER BY x.version DESC LIMIT 1)bp ON true
      LEFT JOIN LATERAL(SELECT * FROM tender.submission_contexts x WHERE x.tender_id=r.tender_id AND x.company_id=r.company_id AND x.lot_key=coalesce(r.lot_key,'') ORDER BY x.created_at DESC LIMIT 1)sc ON true
      LEFT JOIN LATERAL(SELECT * FROM tender.company_profiles x WHERE x.company_id=r.company_id AND x.lifecycle_status='ACTIVE' AND x.valid_from<=now() AND (x.valid_until IS NULL OR x.valid_until>now()) ORDER BY x.version DESC LIMIT 1)profile ON true
      LEFT JOIN tender.final_preflight_contexts f ON f.tender_id=r.tender_id AND f.company_id=r.company_id AND f.lot_key=coalesce(r.lot_key,'') AND f.is_current
      WHERE t.data_class='PUBLIC_REAL' AND t.offer_deadline>now() AND r.primary_company AND ($1::uuid IS NULL OR r.tender_id=$1)
        AND (f.id IS NULL OR f.schema_version<6 OR f.tender_version_id<>tv.id OR f.document_revision_sha256 IS DISTINCT FROM coalesce(bp.document_revision_sha256,ev.payload_sha256)
          OR f.calculation_id IS DISTINCT FROM calc.id OR f.management_output_id IS DISTINCT FROM mo.id OR f.approval_request_id IS DISTINCT FROM approval.id
          OR f.bid_package_id IS DISTINCT FROM bp.id OR f.submission_context_id IS DISTINCT FROM sc.id OR f.company_profile_id IS DISTINCT FROM profile.id)
      ORDER BY t.offer_deadline LIMIT $2`,[tenderId,limit])).rows;
      let requirementCount=0;
      for(const context of contexts){
        await client.query(`UPDATE tender.final_preflight_contexts SET is_current=false,updated_at=now()
          WHERE tender_id=$1 AND lot_key=$2 AND company_id=$3 AND is_current AND tender_version_id<>$4`,[context.tender_id,context.lot_key,context.company_id,context.tender_version_id]);
        const saved=(await client.query(`INSERT INTO tender.final_preflight_contexts(tender_id,tender_version_id,lot_key,company_id,service_line,document_revision_sha256,calculation_id,management_output_id,approval_request_id,bid_package_id,submission_context_id,portal_session_id,company_profile_id,binding_valid,schema_version,transmitted)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,6,false)
          ON CONFLICT(tender_id,lot_key,company_id) WHERE is_current DO UPDATE SET tender_version_id=excluded.tender_version_id,service_line=excluded.service_line,document_revision_sha256=excluded.document_revision_sha256,calculation_id=excluded.calculation_id,management_output_id=excluded.management_output_id,approval_request_id=excluded.approval_request_id,bid_package_id=excluded.bid_package_id,submission_context_id=excluded.submission_context_id,portal_session_id=excluded.portal_session_id,company_profile_id=excluded.company_profile_id,binding_valid=excluded.binding_valid,schema_version=excluded.schema_version,updated_at=now() RETURNING *`,[context.tender_id,context.tender_version_id,context.lot_key,context.company_id,context.service_line,context.document_revision_sha256,context.calculation_id,context.management_output_id,context.approval_request_id,context.bid_package_id,context.submission_context_id,context.portal_session_id,context.company_profile_id,context.binding_valid])).rows[0];
        if(Number(context.prior_schema_version||0)<6){
          await client.query("UPDATE tender.final_preflight_requirements SET status='SUPERSEDED',updated_at=now() WHERE context_id=$1",[saved.id]);
          await client.query("UPDATE tender.required_documents SET satisfaction_status='SUPERSEDED',updated_at=now() WHERE tender_id=$1 AND tender_version_id=$2 AND lot_key=$3 AND company_id=$4 AND source_type='TENDER_DOCUMENT' AND current_upload_id IS NULL",[context.tender_id,context.tender_version_id,context.lot_key,context.company_id]);
        }
        const documents=(await client.query(`SELECT d.id,d.filename,d.extracted_data,d.provenance,l.external_id document_lot_key
          FROM tender.enrichment_documents d JOIN tender.enrichment_versions e ON e.id=d.enrichment_version_id
          LEFT JOIN tender.lots l ON l.id=d.lot_id
          WHERE e.tender_id=$1 AND e.historical=false AND d.procurement_relevant=true AND d.tender_association_verified=true
            AND d.extracted_data IS NOT NULL AND (d.lot_id IS NULL OR l.external_id=$2)`,[context.tender_id,context.lot_key])).rows;
        const discovered=[];
        for(const document of documents){
          const explicitLots=explicitDocumentLotKeys(`${document.filename} ${document.provenance?.archivePath||''} ${document.provenance?.sourceFolderPath||''}`);
          if(explicitLots.length&&!explicitLots.includes(context.lot_key))continue;
          const items=discoverSourceRequirements({pages:extractPages(document.extracted_data),sourceDocumentId:document.id,sourceReference:document.filename,lotKey:document.document_lot_key||'',deadline:context.offer_deadline});
          discovered.push(...items);
        }
        for(const item of discovered){
          await client.query(`INSERT INTO tender.final_preflight_requirements(context_id,requirement_key,requirement_kind,title,description,source_type,source_document_id,source_page,source_reference,source_excerpt,source_evidence_sha256,scope_type,category,mandatory,submission_relevant,human_action_required,legal_confirmation_required,action_group,status,due_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
            ON CONFLICT(context_id,requirement_key,source_evidence_sha256) DO UPDATE SET title=excluded.title,description=excluded.description,due_at=excluded.due_at,status=excluded.status,updated_at=now()`,[saved.id,item.requirementKey,item.requirementKind,item.title,item.description,item.sourceType,item.sourceDocumentId,item.sourcePage,item.sourceReference,item.sourceExcerpt,item.sourceEvidenceSha256,item.scopeType,item.category,item.mandatory,item.submissionRelevant,item.humanActionRequired,item.legalConfirmationRequired,item.actionGroup,item.status,item.dueAt]);
          if(["REQUIRED_DOCUMENT","PORTAL_FORM"].includes(item.requirementKind)) await client.query(`INSERT INTO tender.required_documents(tender_id,tender_version_id,lot_key,company_id,requirement_code,requirement_title,requirement_description,source_document_id,source_page,source_reference,category,document_type,mandatory,submission_relevant,accepted_formats,max_file_size,satisfaction_status,source_type,reusable_company_evidence)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,ARRAY['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],20971520,'MISSING',$15,$14)
            ON CONFLICT(tender_id,tender_version_id,lot_key,company_id,requirement_code) DO UPDATE SET requirement_title=excluded.requirement_title,requirement_description=excluded.requirement_description,source_document_id=excluded.source_document_id,source_page=excluded.source_page,source_reference=excluded.source_reference,source_type=excluded.source_type,satisfaction_status=CASE WHEN tender.required_documents.satisfaction_status='SUPERSEDED' THEN 'MISSING' ELSE tender.required_documents.satisfaction_status END,updated_at=now()`,[context.tender_id,context.tender_version_id,context.lot_key,context.company_id,item.requirementKey,item.title,item.description,item.sourceDocumentId,item.sourcePage,item.sourceReference,item.category,item.mandatory,item.submissionRelevant,["INSURANCE","REGISTER","CERTIFICATE"].includes(item.category),item.requirementKind==="PORTAL_FORM"?"PORTAL_FORM":"TENDER_DOCUMENT"]);
        }
        await client.query(`WITH matches AS(SELECT r.id,e.id evidence_id FROM tender.required_documents r JOIN tender.evidence_items e ON e.company_id=r.company_id
          WHERE r.tender_id=$1 AND r.tender_version_id=$2 AND r.lot_key=$3 AND r.company_id=$4 AND r.reusable_company_evidence
            AND r.satisfaction_status IN('MISSING','AVAILABLE') AND e.status IN('VERIFIED','VALIDATED','AVAILABLE') AND (e.valid_until IS NULL OR e.valid_until>=current_date)
            AND upper(e.evidence_type)=upper(r.category)),links AS(INSERT INTO tender.required_document_company_evidence_links(required_document_id,evidence_item_id,matched_by)
          SELECT id,evidence_id,'GENERIC_EXACT_COMPANY_AND_EVIDENCE_TYPE' FROM matches ON CONFLICT DO NOTHING)
          UPDATE tender.required_documents r SET satisfaction_status='VALIDATED',source_type='COMPANY_EVIDENCE',updated_at=now() WHERE r.id IN(SELECT id FROM matches)`,[context.tender_id,context.tender_version_id,context.lot_key,context.company_id]);
        await client.query(`UPDATE tender.final_preflight_requirements f SET status='VALIDATED',updated_at=now() FROM tender.required_documents r
          WHERE f.context_id=$1 AND f.requirement_key=r.requirement_code AND r.tender_id=$2 AND r.tender_version_id=$3 AND r.lot_key=$4 AND r.company_id=$5 AND r.satisfaction_status='VALIDATED'`,[saved.id,context.tender_id,context.tender_version_id,context.lot_key,context.company_id]);
        requirementCount+=discovered.length;
        const requirements=(await client.query("SELECT * FROM tender.final_preflight_requirements WHERE context_id=$1 AND status<>'SUPERSEDED'",[saved.id])).rows,
          requiredDocumentsForReadiness=(await client.query("SELECT id,requirement_title title,satisfaction_status status,mandatory,submission_relevant,false human_action_required,'REQUIRED_DOCUMENT' requirement_kind FROM tender.required_documents WHERE tender_id=$1 AND tender_version_id=$2 AND lot_key=$3 AND company_id=$4 AND satisfaction_status<>'SUPERSEDED'",[context.tender_id,context.tender_version_id,context.lot_key,context.company_id])).rows,
          allReadinessRequirements=[...requirements,...requiredDocumentsForReadiness];
        for(const requirement of requirements.filter(x=>x.human_action_required && !["VALIDATED","NOT_REQUIRED"].includes(x.status))){
          await client.query(`INSERT INTO tender.final_preflight_user_actions(context_id,requirement_id,action_type,display_title,instruction,priority,due_at)
            VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(requirement_id,action_type) DO UPDATE SET display_title=excluded.display_title,instruction=excluded.instruction,due_at=excluded.due_at,updated_at=now()`,[saved.id,requirement.id,requirement.action_group,requirement.title,requirement.legal_confirmation_required?'Bewusste Bestätigung durch eine berechtigte Person erforderlich.':'Fehlende Angabe oder Unterlage fachlich bearbeiten.',context.offer_deadline&&new Date(context.offer_deadline)-Date.now()<172800000?'CRITICAL':'NORMAL',context.offer_deadline]);
        }
        const schema=(await client.query("SELECT * FROM tender.portal_submission_schemas WHERE context_id=$1 AND is_current",[saved.id])).rows[0];
        const approval=(await client.query("SELECT status,expires_at FROM tender.approval_requests WHERE id=$1",[saved.approval_request_id])).rows[0];
        const submission=(await client.query("SELECT preflight_status,transmitted FROM tender.submission_contexts WHERE id=$1",[saved.submission_context_id])).rows[0];
        const readiness=evaluatePackageReadiness({bindingValid:saved.binding_valid,requirements:allReadinessRequirements,portalSchemaAuthoritative:schema?.authoritative===true,portalMappingComplete:Boolean(schema?.schema_payload?.mappingComplete),bidPackage:saved.bid_package_id,activeCompanyProfile:Boolean(saved.company_profile_id),approvalValid:approval?.status==='APPROVED'&&(!approval.expires_at||new Date(approval.expires_at)>new Date()),submissionContextValid:submission?.preflight_status==='PREFLIGHT_PASSED'&&submission.transmitted===false});
        await client.query(`INSERT INTO tender.package_readiness_checks(context_id,bid_package_id,status,blockers,binding_valid,portal_mapping_complete,required_documents_complete,human_actions_complete,transmitted)
          VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,false)`,[saved.id,saved.bid_package_id,readiness.status,JSON.stringify(readiness.blockers),saved.binding_valid,Boolean(schema?.schema_payload?.mappingComplete),readiness.requiredDocumentsComplete,readiness.humanActionsComplete]);
        await client.query("UPDATE tender.final_preflight_contexts SET readiness_status=$2,schema_sha256=encode(digest($3,'sha256'),'hex'),discovered_at=now(),updated_at=now() WHERE id=$1",[saved.id,readiness.status,JSON.stringify(discovered.map(x=>x.sourceEvidenceSha256).sort())]);
      }
      await client.query("COMMIT");return {processed:contexts.length,requirements:requirementCount};
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
  };
  const preflightTimer=setInterval(()=>reconcileFinalPreflight().catch((error)=>app.log.error({error:error.message},"generic final preflight reconciliation failed")),60000);
  preflightTimer.unref?.();setTimeout(()=>reconcileFinalPreflight().catch((error)=>app.log.error({error:error.message},"initial generic final preflight reconciliation failed")),2500).unref?.();
  app.addHook("onClose",async()=>clearInterval(preflightTimer));
  app.get("/api/final-preflight/contexts",{preHandler:read},async(req)=>{
    const tenderId=String(req.query?.tenderId||"").trim();
    if(tenderId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenderId))return {items:[],transmitted:false,externalSubmission:false};
    const companyIds=req.identity.permissions.includes("tender.admin")?null:req.identity.companyIds;
    const rows=(await pool.query(`SELECT c.*,
      (SELECT status FROM tender.calculations calculation WHERE calculation.id=c.calculation_id) calculation_status,
      (SELECT status FROM tender.management_outputs management WHERE management.id=c.management_output_id) management_output_status,
      (SELECT status FROM tender.approval_requests approval WHERE approval.id=c.approval_request_id) approval_status,
      coalesce(jsonb_agg(jsonb_build_object('group',r.action_group,'title',r.title,'status',r.status,'source',r.source_reference,'page',r.source_page,'dueAt',r.due_at,'humanActionRequired',r.human_action_required)) FILTER(WHERE r.id IS NOT NULL),'[]'::jsonb) requirements
      FROM tender.current_final_preflight_contexts c JOIN tender.current_registered_tender_company_portals registered ON registered.tender_id=c.tender_id AND registered.company_id=c.company_id LEFT JOIN tender.final_preflight_requirements r ON r.context_id=c.id AND r.status<>'SUPERSEDED'
      WHERE ($1::uuid IS NULL OR c.tender_id=$1) AND ($2::uuid[] IS NULL OR c.company_id=ANY($2)) GROUP BY c.id,c.tender_id,c.tender_version_id,c.lot_key,c.company_id,c.service_line,c.document_revision_sha256,c.calculation_id,c.management_output_id,c.approval_request_id,c.bid_package_id,c.submission_context_id,c.portal_session_id,c.binding_valid,c.schema_version,c.schema_sha256,c.readiness_status,c.transmitted,c.is_current,c.discovered_at,c.created_at,c.updated_at,c.title,c.offer_deadline,c.company_name ORDER BY c.offer_deadline`,[tenderId||null,companyIds])).rows;
    return {items:rows,transmitted:false,externalSubmission:false};
  });
  app.get("/api/management/final-preflight-actions",{preHandler:read},async(req)=>{const companyIds=req.identity.permissions.includes("tender.admin")?null:req.identity.companyIds;return {items:(await pool.query(`SELECT a.id,a.display_title,a.instruction,a.priority,a.status,a.due_at,c.title tender_title,c.tender_id,c.lot_key,c.company_id,c.company_name,c.service_line,r.action_group,r.source_reference,r.source_page,p.display_name portal_name
      FROM tender.final_preflight_user_actions a JOIN tender.final_preflight_requirements r ON r.id=a.requirement_id JOIN tender.current_final_preflight_contexts c ON c.id=a.context_id JOIN tender.current_registered_tender_company_portals registered ON registered.tender_id=c.tender_id AND registered.company_id=c.company_id JOIN tender.portal_registry p ON p.id=registered.portal_id
      WHERE a.status IN('OPEN','IN_PROGRESS') AND r.status<>'SUPERSEDED' AND ($1='' OR c.service_line=$1) AND ($2='' OR r.action_group=$2)
        AND ($3='' OR c.company_id::text=$3) AND ($4='' OR c.tender_id::text=$4) AND ($5='' OR c.lot_key=$5) AND ($6='' OR a.priority=$6) AND ($7::uuid[] IS NULL OR c.company_id=ANY($7))
      ORDER BY a.due_at NULLS LAST,a.priority DESC`,[String(req.query?.serviceLine||''),String(req.query?.blockerType||''),String(req.query?.company||''),String(req.query?.tender||''),String(req.query?.lot||''),String(req.query?.priority||''),companyIds])).rows};});
  const list = (path, permission, sql) =>
    app.get(path, { preHandler: requirePermission(permission) }, async () => ({
      items: (await pool.query(sql)).rows,
    }));
  const xmlText = (value) =>
    Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
  const xmlValue = (xml, tag) =>
    xml
      .match(new RegExp(`<[^>]*${tag}[^>]*>([^<]+)</[^>]*${tag}>`, "i"))?.[1]
      ?.trim() || null;
  const noticeLifecycles = async (tenderIds) => {
    if (!tenderIds.length) return new Map();
    const latest = (
      await pool.query(
        `SELECT DISTINCT ON(e.tender_id) e.tender_id,e.notice_type,e.historical,e.raw_payload,t.external_id,t.offer_deadline
      FROM tender.enrichment_versions e JOIN tender.tenders t ON t.id=e.tender_id
      WHERE e.tender_id=ANY($1::uuid[]) ORDER BY e.tender_id,e.version DESC`,
        [tenderIds],
      )
    ).rows;
    const awards = latest.filter(
        (row) => row.notice_type === "AWARD_NOTICE" && row.historical,
      ),
      procedureIds = new Set(
        awards
          .map((row) => xmlValue(xmlText(row.raw_payload), "ContractFolderID"))
          .filter(Boolean),
      );
    const originals = procedureIds.size
      ? (
          await pool.query(`SELECT DISTINCT ON(e.tender_id) e.tender_id,e.notice_type,e.raw_payload,t.external_id,t.offer_deadline,t.title
      FROM tender.enrichment_versions e JOIN tender.tenders t ON t.id=e.tender_id
      WHERE e.notice_type<>'AWARD_NOTICE' ORDER BY e.tender_id,e.version DESC`)
        ).rows
      : [];
    const originalByProcedure = new Map();
    for (const row of originals) {
      const procedureId = xmlValue(
        xmlText(row.raw_payload),
        "ContractFolderID",
      );
      if (procedureIds.has(procedureId))
        originalByProcedure.set(procedureId, row);
    }
    return new Map(
      latest.map((row) => {
        if (row.notice_type !== "AWARD_NOTICE" || !row.historical)
          return [String(row.tender_id), null];
        const xml = xmlText(row.raw_payload),
          procedureId = xmlValue(xml, "ContractFolderID"),
          original = originalByProcedure.get(procedureId);
        return [
          String(row.tender_id),
          {
            status: "COMPLETED",
            statusLabel: "Verfahren abgeschlossen",
            noticeType: "AWARD_NOTICE",
            noticeTypeLabel: "Zuschlagsbekanntmachung",
            resultLabel: "Zuschlag veröffentlicht",
            offerLabel: "Nicht mehr möglich",
            calculationLabel: "Nicht erforderlich – Verfahren bereits vergeben",
            portalAccessLabel: "Für Angebotsbearbeitung nicht erforderlich",
            documentStatusLabel:
              "Für dieses abgeschlossene Verfahren keine Angebotsunterlagen erforderlich",
            monitoringLabel: "Abgeschlossen / Ergebnis erfasst",
            awardDate: xmlValue(xml, "AwardDate"),
            procedureId,
            noticeSubtype: xmlValue(xml, "NoticeSubTypeCode"),
            original: original
              ? {
                  tenderId: original.tender_id,
                  noticeId: original.external_id,
                  offerDeadline: original.offer_deadline,
                  title: original.title,
                }
              : null,
          },
        ];
      }),
    );
  };
  app.get(
    "/api/internal-acceptance",
    { preHandler: requirePermission("tender.admin") },
    async () => ({
      classification: "INTERNAL_ACCEPTANCE_FIXTURE",
      excludedFromRealTenderLists: true,
      excludedFromBoardMetrics: true,
      excludedFromExternalStatistics: true,
      externalWritesEnabled: false,
      items: (
        await pool.query(
          `SELECT f.fixture_key,f.tender_id,f.company_id,f.service_area,f.manifest_sha256,f.classification,f.transmitted,f.created_at,f.completed_at,t.title,c.legal_name,q.id job_id,q.status job_status,q.current_step,q.calculation_status,q.documents_found,q.documents_downloaded,q.documents_analyzed,q.finished_at,a.canonical_snapshot_id,a.historical,a.read_model_status,a.result_version,a.stage_status,calc.status calculation_result_status,calc.totals calculation,m.status management_status,m.payload management_output,m.output_sha256 management_output_sha256 FROM tender.current_internal_acceptance_fixtures f JOIN tender.tenders t ON t.id=f.tender_id JOIN tender.enterprise_company_links c ON c.company_id=f.company_id LEFT JOIN LATERAL(SELECT * FROM tender.autopilot_queue x WHERE x.tender_id=f.tender_id AND x.company_id=f.company_id ORDER BY x.created_at DESC LIMIT 1)q ON true LEFT JOIN LATERAL(SELECT * FROM tender.autopilot_results x WHERE x.tender_id=f.tender_id AND x.company_id=f.company_id AND x.historical=false ORDER BY x.result_version DESC LIMIT 1)a ON true LEFT JOIN LATERAL(SELECT * FROM tender.calculations x WHERE x.tender_id=f.tender_id AND x.company_id=f.company_id ORDER BY x.version DESC LIMIT 1)calc ON true LEFT JOIN LATERAL(SELECT * FROM tender.management_outputs x WHERE x.tender_id=f.tender_id AND x.company_id=f.company_id AND x.historical=false ORDER BY x.created_at DESC LIMIT 1)m ON true ORDER BY f.fixture_key`,
        )
      ).rows,
    }),
  );
  app.get("/api/autopilot/status", { preHandler: read }, async () => ({
    phases: (
      await pool.query(
        "SELECT code,enabled,external_effect,description FROM tender.feature_flags ORDER BY code",
      )
    ).rows,
    externalWritesEnabled: false,
    external_submission_enabled: false,
    productionPortalAccessEnabled: false,
  }));
  app.get(
    "/api/autopilot/calculation/:id",
    { preHandler: requirePermission("tender.board.view") },
    async (req, reply) => {
      if (!(await visibleTender(req, reply, req.params.id))) return;
      const companies = await accessibleCompanies(req.identity),
        company = companies.find(
          (row) => String(row.company_id) === String(req.query?.company || ""),
        );
      if (!company)
        return reply.code(403).send({ error: "company_scope_forbidden" });
      if (!(await requireRegisteredScope(reply, req.params.id, company.company_id))) return;
      const lotKey = String(req.query?.lot || "");
      const [
        calculationResult,
        lotResult,
        managementResult,
        approvalResult,
        documentsResult,
        snapshotResult,
        tenderResult,
      ] = await Promise.all([
        pool.query(
          "SELECT * FROM tender.calculations WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3 ORDER BY version DESC,created_at DESC LIMIT 1",
          [req.params.id, company.company_id, lotKey],
        ),
        pool.query(
          "SELECT id,external_id,title,description FROM tender.lots WHERE tender_id=$1 AND external_id=$2 LIMIT 1",
          [req.params.id, lotKey],
        ),
        pool.query(
          "SELECT id,document_revision,status,payload,created_at FROM tender.management_outputs WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3 AND historical=false ORDER BY created_at DESC LIMIT 1",
          [req.params.id, company.company_id, lotKey],
        ),
        pool.query(
          "SELECT a.id,a.status,a.expires_at,a.created_at,a.payload_manifest,a.payload_manifest->>'auditId' audit_id FROM tender.approval_requests a JOIN tender.calculations c ON c.id=a.calculation_id WHERE c.tender_id=$1 AND c.company_id=$2 AND c.lot_key=$3 ORDER BY a.created_at DESC LIMIT 1",
          [req.params.id, company.company_id, lotKey],
        ),
        pool.query(
          `SELECT DISTINCT ON(d.id) d.filename,d.source_url,d.payload_sha256,d.provenance FROM tender.enrichment_documents d JOIN tender.enrichment_versions e ON e.id=d.enrichment_version_id WHERE e.tender_id=$1 AND (d.lot_id IS NULL OR d.lot_id=(SELECT id FROM tender.lots WHERE tender_id=$1 AND external_id=$2 LIMIT 1)) AND d.procurement_relevant=true ORDER BY d.id,d.created_at DESC`,
          [req.params.id, lotKey],
        ),
        pool.query(
          "SELECT id FROM tender.canonical_read_snapshots WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3 AND status='CURRENT' ORDER BY created_at DESC LIMIT 1",
          [req.params.id, company.company_id, lotKey],
        ),
        pool.query(
          "SELECT id,title,buyer,source_code,offer_deadline,procurement_number,notice_number,external_id FROM tender.tenders WHERE id=$1",
          [req.params.id],
        ),
      ]);
      const calculation = calculationResult.rows[0],
        tender = tenderResult.rows[0];
      if (!calculation || !tender)
        return reply.code(404).send({ error: "calculation_not_found" });
      reply
        .header("Cache-Control", "private, no-store, max-age=0")
        .header("Vary", "Cookie");
      const view = buildCalculationViewModel({
        tender,
        company,
        lot: lotResult.rows[0] || null,
        calculation,
        managementOutput: managementResult.rows[0] || null,
        approval: approvalResult.rows[0] || null,
        documents: documentsResult.rows,
        snapshotId: snapshotResult.rows[0]?.id || null,
      });
      view.approval.confirmationPhrase = BID_APPROVAL_CONFIRMATION_PHRASE;
      view.approvalSummary.confirmationPhrase =
        BID_APPROVAL_CONFIRMATION_PHRASE;
      view.currentUserInputs = (
        await pool.query(
          "SELECT field_key,value,unit,version,created_at FROM tender.calculation_user_inputs WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3 AND active=true AND transmitted=false ORDER BY field_key",
          [req.params.id, company.company_id, lotKey],
        )
      ).rows;
      return view;
    },
  );
  app.post(
    "/api/tenders/:id/calculation-inputs",
    { preHandler: [requirePermission("tender.calculation.create"), csrf] },
    async (req, reply) => {
      if (!(await visibleTender(req, reply, req.params.id))) return;
      const companyId = String(req.body?.companyId || ""),
        lotKey = String(req.body?.lotKey || ""),
        fieldKey = String(req.body?.fieldKey || ""),
        companies = await accessibleCompanies(req.identity),
        company = companies.find((row) => String(row.company_id) === companyId);
      if (!company) return reply.code(403).send({ error: "company_scope_forbidden" });
      if (!(await requireRegisteredScope(reply, req.params.id, companyId))) return;
      const validated = validateExplicitCalculationInput(fieldKey, req.body?.value, req.body?.unit);
      if (!validated.valid) return reply.code(422).send({ error: validated.error, message: "Der Kalkulationswert oder seine Einheit ist ungültig." });
      const current = (
        await pool.query(
          "SELECT blocked_reasons FROM tender.calculations WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3 ORDER BY version DESC,created_at DESC LIMIT 1",
          [req.params.id, companyId, lotKey],
        )
      ).rows[0];
      const isCurrentlyMissing = (current?.blocked_reasons || []).some((item) => String(item?.field || "") === validated.definition.inputLabel);
      if (!isCurrentlyMissing)
        return reply.code(409).send({ error: "calculation_input_not_currently_missing", message: "Dieser Wert ist in der aktuellen Kalkulation nicht als fehlend ausgewiesen." });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const previous = (
          await client.query(
            "SELECT id,version FROM tender.calculation_user_inputs WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3 AND field_key=$4 AND active=true FOR UPDATE",
            [req.params.id, companyId, lotKey, fieldKey],
          )
        ).rows[0];
        const inputId = crypto.randomUUID(),
          version = Number(previous?.version || 0) + 1;
        if (previous) await client.query("UPDATE tender.calculation_user_inputs SET active=false WHERE id=$1", [previous.id]);
        const
          saved = (
            await client.query(
              `INSERT INTO tender.calculation_user_inputs(id,tender_id,company_id,lot_key,field_key,field_label,value,unit,source_reason,version,created_by,transmitted)
               VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,false) RETURNING id,field_key,value,unit,version,created_at,transmitted`,
              [inputId, req.params.id, companyId, lotKey, fieldKey, validated.definition.label, JSON.stringify(validated.value), validated.unit, validated.definition.explanation, version, req.identity.userId],
            )
          ).rows[0];
        if (previous) {
          await client.query("UPDATE tender.calculation_user_inputs SET active=false,superseded_by=$2 WHERE id=$1", [previous.id, saved.id]);
        }
        await client.query(
          "INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'CALCULATION_USER_INPUT_RECORDED',$2,$3::jsonb)",
          [req.identity.userId, req.params.id, JSON.stringify({ companyId, lotKey, fieldKey, inputId: saved.id, version, unit: validated.unit, externalWrite: false, transmitted: false })],
        );
        await client.query("COMMIT");
        return reply.code(previous ? 200 : 201).send({ ...saved, companyId, lotKey, externalSubmission: false });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );
  app.get(
    "/api/autopilot/navigation/overview",
    { preHandler: read },
    async (req) => {
      const companies = await accessibleCompanies(req.identity),
        companyIds = companies.map((row) => row.company_id);
      if (!companyIds.length) return { items: [], companies };
      const filter = String(req.query?.relevance || "relevant"),
        statuses =
          filter === "all"
            ? null
            : filter === "excluded"
              ? ["NOT_RELEVANT", "EXCLUDED", "NOT_APPLICABLE"]
              : filter === "review"
                ? ["POTENTIALLY_RELEVANT", "MANUAL_CLASSIFICATION_REQUIRED"]
                : ["RELEVANT", "POTENTIALLY_RELEVANT"];
      const rawItems = (
        await pool.query(
          `WITH candidates AS(SELECT r.*,t.title,t.external_id,t.notice_number,t.procurement_number,t.ted_id,t.buyer,t.cpv_codes,t.source_code,t.regions,t.offer_deadline,t.created_at tender_created_at,c.legal_name,
        row_number() OVER(PARTITION BY r.tender_id,r.lot_key ORDER BY r.primary_company DESC,r.relevance_status,r.company_id) canonical_rank,
        bool_or(r.primary_company) OVER(PARTITION BY r.tender_id,r.lot_key) has_primary
      FROM tender.current_service_relevance r
      JOIN tender.current_registered_tender_company_portals registered
        ON registered.tender_id=r.tender_id AND registered.company_id=r.company_id
      JOIN tender.tenders t ON t.id=r.tender_id JOIN tender.enterprise_company_links c ON c.company_id=r.company_id
      WHERE r.company_id=ANY($1::uuid[]) AND t.data_class='PUBLIC_REAL')
      SELECT rm.tender_id,rm.title,rm.external_id,rm.notice_number,rm.procurement_number,rm.ted_id,rm.buyer,rm.cpv_codes,rm.source_code,rm.company_id,CASE WHEN rm.primary_company THEN rm.legal_name ELSE 'Keine' END company,
        rm.lot_key,l.id lot_id,l.external_id lot_number,l.title lot_title,rm.regions,rm.offer_deadline,rm.evaluation_version relevance_version,rm.relevance_status,rm.service_scope_gate,
        rm.service_line,rm.reason relevance_reason,rm.recommendation relevance_recommendation,
        ar.result_version,ev.version enrichment_version,ar.created_at,ar.stage_status,ar.review,ar.prepared_tasks,
        q.id job_id,q.status job_status,q.current_step,q.progress_percent,q.last_successful_step,q.next_step,q.blocking_reason,
        q.missing_calculation_inputs,coalesce(q.calculation_status,ar.stage_status->>'calculation') calculation_status,q.heartbeat_at job_updated_at,q.document_portal,q.portal_access_status,
        q.documents_found,q.documents_downloaded,q.documents_analyzed,pc.fachlich_status pipeline_status,pc.current_step pipeline_step,pc.blocking_state pipeline_blocking_state,pc.completed_steps pipeline_completed_steps,pc.profile_snapshot_id
      FROM candidates rm
      LEFT JOIN tender.lots l ON l.tender_id=rm.tender_id AND l.external_id IS NOT DISTINCT FROM rm.lot_key
      LEFT JOIN LATERAL(SELECT r.result_version,r.enrichment_version_id,r.created_at,r.stage_status,r.review,r.prepared_tasks FROM tender.autopilot_results r WHERE r.tender_id=rm.tender_id AND r.company_id=rm.company_id AND r.lot_key IS NOT DISTINCT FROM rm.lot_key ORDER BY r.result_version DESC LIMIT 1)ar ON true
      LEFT JOIN tender.enrichment_versions ev ON ev.id=ar.enrichment_version_id
      LEFT JOIN tender.pipeline_contexts pc ON pc.tender_id=rm.tender_id AND pc.company_id=rm.company_id AND pc.lot_key=coalesce(rm.lot_key,'') AND pc.pipeline_version='wb-tender-pipeline/5.0.0'
      LEFT JOIN LATERAL(SELECT q.* FROM tender.autopilot_queue q WHERE q.tender_id=rm.tender_id AND q.company_id=rm.company_id AND q.lot_key IS NOT DISTINCT FROM rm.lot_key AND q.action_type='RUN_FULL_PIPELINE' ORDER BY q.created_at DESC LIMIT 1)q ON true
      WHERE ($2::text[] IS NULL OR rm.relevance_status=ANY($2)) AND (rm.primary_company OR ($3::boolean AND NOT rm.has_primary AND rm.canonical_rank=1))
      ORDER BY rm.offer_deadline NULLS LAST,rm.tender_created_at DESC,rm.tender_id,rm.lot_key NULLS LAST LIMIT 5000`,
          [companyIds, statuses, filter === "excluded" || filter === "all"],
        )
      ).rows;
      const tenderIds=[...new Set(rawItems.map((row)=>row.tender_id))],identityRows=tenderIds.length?(await pool.query(`SELECT DISTINCT ON(e.tender_id) e.tender_id,e.notice_identifier,e.notice_type,e.source_code,e.source_url,e.payload_sha256,e.raw_content_type,e.raw_payload,t.publication_date
        FROM tender.enrichment_versions e JOIN tender.tenders t ON t.id=e.tender_id
        WHERE e.tender_id=ANY($1::uuid[]) AND e.historical=false ORDER BY e.tender_id,e.version DESC`,[tenderIds])).rows:[],identityByTender=new Map();
      for(const row of identityRows){
        const payload=Buffer.isBuffer(row.raw_payload)?row.raw_payload.toString("utf8"):String(row.raw_payload||"");
        let procedureId=payload.match(/<[^>]*ContractFolderID[^>]*>([^<]+)</i)?.[1]?.trim()||null;
        if(!procedureId && payload.trimStart().startsWith("{"))try{const parsed=JSON.parse(payload),ocid=String(parsed.ocid||"");procedureId=ocid.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)?.[0]||parsed.tender?.id||parsed.procedure?.id||null}catch{}
        identityByTender.set(String(row.tender_id),{procedureId,noticeId:row.notice_identifier,noticeType:row.notice_type,sourceCode:row.source_code,sourceUrl:row.source_url,sourceHash:row.payload_sha256,publicationDate:row.publication_date});
      }
      const groups=new Map();
      for(const row of rawItems){
        const identity=identityByTender.get(String(row.tender_id))||{},procedureId=identity.procedureId||`TENDER:${row.tender_id}`,key=`${procedureId}:${row.company_id}`,existing=groups.get(key);
        if(!existing){groups.set(key,{...row,canonical_procedure_id:procedureId,procedure_grouped:true,source_notices:[],lots:[],lot_count:0,document_complete_count:0,calculation_complete_count:0,open_user_actions:0});}
        const group=groups.get(key),noticeKey=`${identity.sourceCode||row.source_code}:${identity.noticeId||row.external_id}`;
        if(!group.source_notices.some((notice)=>notice.identity===noticeKey))group.source_notices.push({identity:noticeKey,tenderId:row.tender_id,publicationId:identity.noticeId||row.external_id,noticeType:identity.noticeType,sourceCode:identity.sourceCode||row.source_code,sourceUrl:identity.sourceUrl,sourceHash:identity.sourceHash,publicationDate:identity.publicationDate});
        const lotKey=row.lot_key||"_tender";
        if(!group.lots.some((lot)=>lot.lot_key===lotKey))group.lots.push({...row,lot_key:row.lot_key||null});
        const prefer=(identity.noticeType==='ACTIVE_PROCUREMENT_NOTICE'?2:0)+(row.offer_deadline?1:0),currentIdentity=identityByTender.get(String(group.tender_id))||{},currentPrefer=(currentIdentity.noticeType==='ACTIVE_PROCUREMENT_NOTICE'?2:0)+(group.offer_deadline?1:0);
        if(prefer>currentPrefer)Object.assign(group,{...row,canonical_procedure_id:procedureId,procedure_grouped:true,source_notices:group.source_notices,lots:group.lots});
      }
      const items=[...groups.values()].map((group)=>{group.lots.sort((a,b)=>String(a.lot_key||"").localeCompare(String(b.lot_key||""),"de"));group.lot_count=group.lots.length;group.document_complete_count=group.lots.filter((lot)=>Number(lot.documents_found)>0&&Number(lot.documents_downloaded)>=Number(lot.documents_found)&&Number(lot.documents_analyzed)>=Number(lot.documents_downloaded)).length;group.calculation_complete_count=group.lots.filter((lot)=>['CALCULATED','CALCULATED_REAL'].includes(lot.calculation_status)).length;return group;});
      return {
        items,
        total: items.length,
        companies,
        filters: { relevance: filter, default: "relevant" },
        externalWritesEnabled: false,
      };
    },
  );
  app.get(
    "/api/autopilot/navigation/context/:tenderId",
    { preHandler: read },
    async (req, reply) => {
      const tender = await visibleTender(req, reply, req.params.tenderId);
      if (!tender) return;
      const companies = await accessibleCompanies(req.identity),
        requested = String(req.query?.company || "");
      const company =
        companies.find((row) => String(row.company_id) === requested) ||
        companies[0];
      if (!company)
        return reply
          .code(403)
          .send({
            error: "company_scope_forbidden",
            message: "Für keine Gesellschaft besteht eine Tender-Berechtigung.",
          });
      if (requested && String(company.company_id) !== requested)
        return reply
          .code(403)
          .send({
            error: "company_scope_forbidden",
            message: "Die ausgewählte Gesellschaft ist nicht zulässig.",
          });
      const registeredScope = await requireRegisteredScope(reply, tender.id, company.company_id);
      if (!registeredScope) return;
      const lotKey = String(req.query?.lot || ""),
        resultVersion =
          Number.parseInt(String(req.query?.version || ""), 10) || null;
      let result =
        (
          await pool.query(
            `SELECT * FROM tender.autopilot_results WHERE tender_id=$1 AND company_id=$2
      AND (($3='' AND lot_key IS NULL) OR lot_key=$3) AND ($4::int IS NULL OR result_version=$4)
      ORDER BY result_version DESC LIMIT 1`,
            [tender.id, company.company_id, lotKey, resultVersion],
          )
        ).rows[0] || null;
      const enrichment =
        (
          await pool.query(
            "SELECT id,version,notice_version,notice_type,change_state,retrieved_at,quality_summary,mapper_version,parser_version,created_at FROM tender.enrichment_versions WHERE tender_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY version DESC LIMIT 1",
            [tender.id, result?.enrichment_version_id || null],
          )
        ).rows[0] || null;
      const enrichmentId = enrichment?.id || null;
      const [
        lots,
        versions,
        documents,
        fields,
        requirements,
        calculations,
        tasks,
        approvals,
        audit,
        region,
        offers,
        bidPackages,
      ] = await Promise.all([
        pool.query(
          "SELECT id,external_id,title,description,locations,cpv_codes,value,currency,deadline FROM tender.lots WHERE tender_id=$1 ORDER BY external_id",
          [tender.id],
        ),
        pool.query(
          "SELECT id,version,source_sha256,change_kind,source_timestamp,created_at FROM tender.tender_versions WHERE tender_id=$1 ORDER BY version DESC",
          [tender.id],
        ),
        enrichmentId
          ? pool.query(
              "SELECT id,lot_id,document_type,filename,fetch_status,resolution_status,http_status,mime_type,payload_sha256,parser,parser_version,retrieved_at,provenance,extracted_data FROM tender.enrichment_documents WHERE enrichment_version_id=$1 ORDER BY filename NULLS LAST",
              [enrichmentId],
            )
          : Promise.resolve({ rows: [] }),
        enrichmentId
          ? pool.query(
              "SELECT lot_id,field_key,value,quality_status,provenance,confidence,created_at FROM tender.enrichment_fields WHERE enrichment_version_id=$1 ORDER BY field_key",
              [enrichmentId],
            )
          : Promise.resolve({ rows: [] }),
        pool.query(
          "SELECT id,lot_id,category,requirement,mandatory,status,evidence_needed,due_at FROM tender.requirements WHERE tender_id=$1 ORDER BY category,created_at",
          [tender.id],
        ),
        pool.query(
          "SELECT id,lot_id,lot_key,company_id,version,service_line,scenario,status,blocked_reasons,totals,calculation_mode,scenario_label,scenario_assumptions,created_at FROM tender.calculations WHERE tender_id=$1 AND company_id=$2 ORDER BY version DESC,scenario",
          [tender.id, company.company_id],
        ),
        pool.query(
          "SELECT id,assignee_id,due_at,status,title,created_at FROM tender.tasks WHERE tender_id=$1 ORDER BY due_at NULLS LAST,created_at",
          [tender.id],
        ),
        pool.query(
          "SELECT id,action_type,status,created_at,expires_at FROM tender.approval_requests WHERE tender_id=$1 ORDER BY created_at DESC",
          [tender.id],
        ),
        pool.query(
          "SELECT id,actor_id,action,metadata,occurred_at FROM tender.audit_events WHERE tender_id=$1 ORDER BY id DESC LIMIT 200",
          [tender.id],
        ),
        pool.query(
          "SELECT lot_id,evaluation_version,classification,detected_states,detected_nuts,configuration_version_no,regional_decision,matching_status,explanation,open_conditions,next_action,created_at FROM tender.region_evaluations WHERE tender_id=$1 AND company_id=$2 ORDER BY evaluation_version DESC",
          [tender.id, company.company_id],
        ),
        pool.query(
          `SELECT gd.id,gd.bid_package_id,gd.category,gd.version,gd.format,gd.status,gd.missing_fields,gd.sha256,gd.created_at,gd.internal_draft_only,gd.storage_key
        FROM tender.generated_documents gd JOIN tender.calculations c ON c.id=gd.calculation_id
        WHERE gd.tender_id=$1 AND c.company_id=$2 AND c.lot_key IS NOT DISTINCT FROM $3
        ORDER BY gd.version DESC,gd.created_at DESC`,
          [tender.id, company.company_id, lotKey || null],
        ),
        pool.query(
          `SELECT bp.id,bp.version,bp.status,bp.manifest_sha256,bp.document_revision_sha256,bp.tender_version_id,bp.calculation_id,bp.calculation_version,bp.management_output_id,bp.missing_items,bp.created_at
        FROM tender.bid_packages bp JOIN tender.calculations c ON c.id=bp.calculation_id
        WHERE bp.tender_id=$1 AND bp.lot_key=$2 AND c.company_id=$3
        ORDER BY bp.version DESC,bp.created_at DESC LIMIT 1`,
          [tender.id, lotKey, company.company_id],
        ),
      ]);
      let canonical = !resultVersion
        ? (
            await pool.query(
              "SELECT * FROM tender.canonical_read_snapshots WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3 AND status='CURRENT' ORDER BY created_at DESC LIMIT 1",
              [tender.id, company.company_id, lotKey],
            )
          ).rows[0]
        : null;
      let pipelineJob =
        (
          await pool.query(
            "SELECT id,status,current_step,progress_percent,document_portal,portal_access_status,document_resolution_status,documents_found,documents_downloaded,documents_analyzed,blocking_reason,next_step,heartbeat_at,finished_at FROM tender.autopilot_queue WHERE tender_id=$1 AND company_id=$2 AND lot_key IS NOT DISTINCT FROM $3 AND action_type='RUN_FULL_PIPELINE' ORDER BY created_at DESC LIMIT 1",
            [tender.id, company.company_id, lotKey || null],
          )
        ).rows[0] || null;
      // A completed pipeline run is authoritative over an older materialized read
      // snapshot. Falling back to the current relational rows prevents an old
      // snapshot from masking a newly established portal/document blocker.
      if (
        canonical &&
        pipelineJob?.finished_at &&
        new Date(pipelineJob.finished_at) > new Date(canonical.created_at)
      )
        canonical = null;
      if (canonical) {
        const p = canonical.payload,
          profileParameters = Object.fromEntries(
            Object.entries(p.profile?.parameters || {}).map(([key, item]) => [
              key,
              item?.value,
            ]),
          );
        result = {
          id: canonical.id,
          result_version: null,
          pipeline_version: canonical.pipeline_version,
          canonical_snapshot_id: canonical.snapshot_sha256,
          read_model_status: "CURRENT",
          stage_status: {
            pipeline: p.pipeline.status,
            currentStep: p.pipeline.currentStep,
            blockingState: p.pipeline.blockingState,
            documents:
              p.documentCounts.verified > 0
                ? "PROCUREMENT_DOCUMENTS_VERIFIED"
                : "PROCUREMENT_DOCUMENTS_NOT_VERIFIED",
            calculation: p.calculationInput.status,
            recommendation: p.recommendation.decision,
          },
          review: {
            configurationVersion: null,
            evidence: ["A11", "A12", "A13", "B11"].map((key) => ({
              name: key,
              status:
                profileParameters[key] === undefined
                  ? "UNTERNEHMENSPROFIL_UNVOLLSTÄNDIG"
                  : "manuelle Prüfung erforderlich",
              source:
                profileParameters[key] === undefined
                  ? "aktives Gesellschaftsprofil"
                  : `effective profile snapshot ${p.profile.id}`,
              profileSnapshotId: p.profile?.id || null,
            })),
            calculation: {
              status: p.calculationInput.status,
              parameters: p.calculationInput.parameters,
              missing: p.calculationInput.missing,
              snapshotId: p.calculationInput.id,
            },
            recommendation: p.recommendation,
            canonicalSnapshotId: p.snapshotId,
            consistencyStatus: p.consistencyStatus,
          },
          board_brief: p.boardBrief,
          source_manifest: {
            canonicalSnapshotId: p.snapshotId,
            profileSnapshotId: p.profile?.id || null,
            calculationInputSnapshotId: p.calculationInput.id,
            componentIds: p.componentIds,
          },
        };
        documents.rows = p.documents.map((document) => ({
          ...document,
          fetch_status: document.canonical_status,
          resolution_status: document.canonical_status,
          parser_status: document.canonical_status,
        }));
        calculations.rows = [
          {
            id: p.calculationInput.id,
            lot_key: lotKey,
            company_id: company.company_id,
            version: 2,
            service_line: company.service_line,
            scenario: "CANONICAL",
            status: p.calculationInput.status,
            blocked_reasons: p.calculationInput.missing,
            totals: {
              parameters: p.calculationInput.parameters,
              snapshotId: p.calculationInput.snapshotSha256,
            },
            created_at: canonical.created_at,
          },
        ];
        pipelineJob = {
          id: null,
          status: p.pipeline.status,
          current_step: p.pipeline.currentStep,
          progress_percent: null,
          document_portal: p.portal.status,
          portal_access_status: p.portal.loginResult,
          document_resolution_status:
            p.documentCounts.verified > 0
              ? "PROCUREMENT_DOCUMENTS_VERIFIED"
              : "PROCUREMENT_DOCUMENTS_NOT_VERIFIED",
          documents_found: p.documentCounts.found,
          documents_downloaded: p.documentCounts.verified,
          documents_analyzed: p.documentCounts.analyzed,
          blocking_reason: p.pipeline.blockingState,
          next_step: null,
          heartbeat_at: null,
          finished_at: canonical.created_at,
        };
      }
      const resolutionPriority = [
          "DOWNLOAD_FAILED",
          "DOWNLOAD_PARTIAL_SUCCESS",
          "DOWNLOAD_SUCCEEDED",
          "DOCUMENT_NOT_AVAILABLE",
          "DOCUMENT_LIST_FOUND",
          "LOGIN_SUCCEEDED",
          "PORTAL_ACCESS_REQUIRED",
          "TARGET_PORTAL_IDENTIFIED",
          "PUBLIC_DOCUMENT_AVAILABLE",
        ],
        currentResolution =
          pipelineJob?.document_resolution_status ||
          resolutionPriority.find((status) =>
            documents.rows.some((row) => row.resolution_status === status),
          ) ||
          null;
      const noticeLifecycle =
        (await noticeLifecycles([tender.id])).get(String(tender.id)) || null;
      if (noticeLifecycle && result) {
        result = {
          ...result,
          stage_status: {
            ...(result.stage_status || {}),
            calculation: "NOT_APPLICABLE_AWARD_NOTICE",
          },
          review: {
            ...(result.review || {}),
            calculation: {
              ...(result.review?.calculation || {}),
              status: "NOT_APPLICABLE_AWARD_NOTICE",
              missing: [],
            },
          },
        };
      }
      const documentPortal = noticeLifecycle
        ? {
            Bekanntmachungsquelle: tender.source_code,
            Portalzugriff: noticeLifecycle.portalAccessLabel,
            Dokumentenstatus: noticeLifecycle.documentStatusLabel,
            Kalkulation: noticeLifecycle.calculationLabel,
            Monitoring: noticeLifecycle.monitoringLabel,
          }
        : pipelineJob
          ? {
              Kanonischer_Snapshot: canonical?.snapshot_sha256 || "HISTORISCH",
              Konsistenzstatus: canonical?.consistency_status || "HISTORICAL",
              Bekanntmachungsquelle: tender.source_code,
              Tatsächliches_Dokumentenportal:
                canonical?.payload?.portal?.status ||
                pipelineJob.document_portal ||
                "Noch nicht ermittelt",
              Portalzugangsstatus:
                canonical?.payload?.portal?.loginResult ||
                pipelineJob.portal_access_status ||
                "Noch nicht geprüft",
              Konsolidierter_Dokumentenstatus: canonical
                ? canonical.payload.documentCounts.verified > 0
                  ? "PROCUREMENT_DOCUMENTS_VERIFIED"
                  : "PROCUREMENT_DOCUMENTS_NOT_VERIFIED"
                : currentResolution || "Noch nicht gestartet",
              Gefundene_Dokumente: pipelineJob.documents_found,
              Geladene_Dokumente: pipelineJob.documents_downloaded,
              Analysierte_Dokumente: pipelineJob.documents_analyzed,
              Aktuelle_Job_ID: pipelineJob.id,
              Aktueller_Pipelineschritt: pipelineJob.current_step,
              Blockierungsgrund: pipelineJob.blocking_reason || "–",
              Nächster_Schritt: pipelineJob.next_step || "–",
            }
          : null;
      const bidPackage = bidPackages.rows[0] || null,
        offerCategories = [
          ["PRICE_SHEET", "Preisblatt", /preis|angebot/i],
          [
            "SPECIFICATION",
            "Leistungsverzeichnis",
            /leistungsverzeichnis|\blv\b/i,
          ],
          ["FORMS", "Formblätter", /formblatt|formular/i],
          ["EVIDENCE", "Nachweise", /nachweis|eignung|referenz/i],
          ["CERTIFICATES", "Zertifikate", /zertifikat|bescheinigung/i],
        ],
        offerDocumentChecklist = offerCategories.map(
          ([category, label, pattern]) => {
            const document =
              offers.rows.find(
                (row) =>
                  String(row.bid_package_id) === String(bidPackage?.id) &&
                  row.category === category,
              ) ||
              offers.rows.find((row) =>
                pattern.test(`${row.storage_key || ""} ${row.format || ""}`),
              );
            return {
              category,
              label,
              status: document?.status || "NOT_GENERATED",
              documentId: document?.id || null,
              format: document?.format || null,
              hash: document?.sha256 || null,
              version: document?.version || bidPackage?.version || null,
              reason: document
                ? null
                : `Für das bestehende Bid Package wurde noch kein Dokument der Kategorie „${label}“ erzeugt.`,
            };
          },
        );
      return {
        tender,
        company,
        companies,
        selected: {
          tenderId: tender.id,
          lotKey: lotKey || null,
          companyId: company.company_id,
          resultVersion: result?.result_version || resultVersion,
          canonicalSnapshotId: canonical?.snapshot_sha256 || null,
          historical: Boolean(resultVersion || result?.historical),
        },
        result,
        enrichment,
        lots: lots.rows,
        versions: versions.rows,
        documents: documents.rows,
        fields: fields.rows,
        requirements: requirements.rows,
        calculations: calculations.rows,
        tasks: tasks.rows,
        approvals: approvals.rows,
        audit: audit.rows,
        region: region.rows,
        offerDocuments: offers.rows,
        bidPackage,
        offerDocumentChecklist,
        pipelineJob,
        documentPortal,
        noticeLifecycle,
        scenarioAvailable: calculations.rows.some(
          (x) => x.calculation_mode === "CALCULATED_SCENARIO",
        ),
        externalWritesEnabled: false,
      };
    },
  );
  app.get(
    "/api/tenders/:id/document-workbench",
    { preHandler: read },
    async (req, reply) => {
      if (!(await visibleTender(req, reply, req.params.id))) return;
      const companyId = String(req.query?.company || ""),
        lotKey = String(req.query?.lot || ""),
        companies = await accessibleCompanies(req.identity),
        company = companies.find((row) => String(row.company_id) === companyId);
      if (!company)
        return reply.code(403).send({ error: "company_scope_forbidden" });
      const registeredScope = await requireRegisteredScope(reply, req.params.id, companyId);
      if (!registeredScope) return;
      const relevance = (
        await pool.query(
          "SELECT service_line FROM tender.current_service_relevance WHERE tender_id=$1 AND company_id=$2 AND lot_key IS NOT DISTINCT FROM nullif($3,'') LIMIT 1",
          [req.params.id, companyId, lotKey],
        )
      ).rows[0];
      if (!relevance)
        return reply.code(404).send({ error: "tender_lot_scope_not_found" });
      const [documents, queue, required] = await Promise.all([
        pool.query(
          `SELECT d.id,d.lot_id,el.lot_key document_lot_key,d.document_type,d.filename,d.fetch_status,d.resolution_status,
            d.http_status,d.mime_type,d.payload_sha256,d.parser,d.parser_version,d.retrieved_at,d.provenance,d.source_url,
            d.document_class,d.procurement_relevant,d.tender_association_verified,d.lot_association_verified,d.magic_bytes_verified,
            d.content_size,(d.content IS NOT NULL) has_content,(d.extracted_data IS NOT NULL) has_extracted_data,
            d.procurement_verification_status
          FROM tender.enrichment_documents d
          JOIN tender.enrichment_versions ev ON ev.id=d.enrichment_version_id
          LEFT JOIN tender.enrichment_lots el ON el.id=d.lot_id
          WHERE ev.id=(SELECT id FROM tender.enrichment_versions WHERE tender_id=$1 AND historical=false ORDER BY version DESC LIMIT 1)
          ORDER BY d.filename NULLS LAST,d.id`,
          [req.params.id],
        ),
        pool.query(
          `SELECT id,status,current_step,portal_id,document_portal,portal_access_status,document_resolution_status,
            documents_found,documents_downloaded,documents_analyzed,blocking_reason,next_step,error_code,error_detail_safe
          FROM tender.autopilot_queue WHERE tender_id=$1 AND company_id=$2 AND lot_key IS NOT DISTINCT FROM nullif($3,'')
            AND action_type='RUN_FULL_PIPELINE' ORDER BY created_at DESC LIMIT 1`,
          [req.params.id, companyId, lotKey],
        ),
        pool.query(
          `SELECT id,requirement_title,satisfaction_status,source_type FROM tender.required_documents
          WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3 AND mandatory=true AND submission_relevant=true
            AND satisfaction_status NOT IN('VALIDATED','NOT_REQUIRED','SUPERSEDED') ORDER BY requirement_title`,
          [req.params.id, companyId, lotKey],
        ),
      ]);
      const workbench = buildDocumentWorkbench(documents.rows, {
          lotKey,
          page: req.query?.page,
          pageSize: req.query?.pageSize,
        }),
        job = queue.rows[0] || null,
        portalId = registeredScope.portal_id,
        processing = ["PENDING", "CLAIMED", "QUEUED", "RETRY", "RUNNING"].includes(job?.status),
        actions = [];
      if (!processing && workbench.summary.openOrFailed) {
        if (/PORTAL|SESSION|MFA/i.test(`${job?.portal_access_status || ""} ${job?.document_resolution_status || ""}`))
          actions.push({ type: "PORTAL_ACCESS", portalId });
        if (workbench.summary.failed || workbench.summary.notLoaded)
          actions.push({ type: "RETRY_FETCH" });
        else if (workbench.summary.notAnalyzed)
          actions.push({ type: "START_ANALYSIS" });
      }
      if (required.rows.length)
        actions.push({ type: "REQUIRED_DOCUMENTS", count: required.rows.length, firstId: required.rows[0].id });
      if (!processing && !workbench.summary.openOrFailed && /Kalkulation blockiert|FEHLENDE_DATEN/i.test(`${job?.blocking_reason || ""} ${job?.next_step || ""}`))
        actions.push({ type: "CALCULATION", reason: job?.blocking_reason });
      return {
        ...workbench,
        items: workbench.items.map((document) => ({
          ...document,
          downloadUrl: document.has_content
            ? `/api/tender/tenders/${encodeURIComponent(req.params.id)}/document-workbench/${encodeURIComponent(document.id)}/file?company=${encodeURIComponent(companyId)}&lot=${encodeURIComponent(lotKey)}`
            : null,
        })),
        actions,
        requiredDocuments: { open: required.rows.length },
        pipeline: job,
        portalId,
        nextWorkflow: workbench.summary.openOrFailed || processing
          ? null
          : { view: "calculation", label: "Kalkulation öffnen", reason: job?.blocking_reason || "Die Vergabeunterlagen sind vollständig verarbeitet." },
        selected: { tenderId: req.params.id, companyId, lotKey },
        externalWritesEnabled: false,
        transmitted: false,
      };
    },
  );
  app.get(
    "/api/tenders/:id/document-workbench/:documentId/file",
    { preHandler: read },
    async (req, reply) => {
      if (!(await visibleTender(req, reply, req.params.id))) return;
      const companyId = String(req.query?.company || ""),
        lotKey = String(req.query?.lot || ""),
        companies = await accessibleCompanies(req.identity);
      if (!companies.some((row) => String(row.company_id) === companyId))
        return reply.code(403).send({ error: "company_scope_forbidden" });
      if (!(await requireRegisteredScope(reply, req.params.id, companyId))) return;
      const relevance = (
        await pool.query(
          "SELECT 1 FROM tender.current_service_relevance WHERE tender_id=$1 AND company_id=$2 AND lot_key IS NOT DISTINCT FROM nullif($3,'') LIMIT 1",
          [req.params.id, companyId, lotKey],
        )
      ).rows[0];
      if (!relevance)
        return reply.code(404).send({ error: "tender_lot_scope_not_found" });
      const document = (
        await pool.query(
          `SELECT d.*,el.lot_key document_lot_key,(d.content IS NOT NULL) has_content,(d.extracted_data IS NOT NULL) has_extracted_data
          FROM tender.enrichment_documents d JOIN tender.enrichment_versions ev ON ev.id=d.enrichment_version_id
          LEFT JOIN tender.enrichment_lots el ON el.id=d.lot_id
          WHERE d.id=$1 AND ev.tender_id=$2 AND ev.historical=false`,
          [req.params.documentId, req.params.id],
        )
      ).rows[0];
      if (!document || !documentInScope(document, lotKey) || !document.content)
        return reply.code(404).send({ error: "scoped_document_not_found" });
      return reply
        .header("content-type", document.mime_type || "application/octet-stream")
        .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(safeOriginalFilename(document.filename || "Dokument"))}`)
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "private, no-store")
        .header("content-security-policy", "sandbox")
        .send(document.content);
    },
  );
  list(
    "/api/profiles",
    "tender.view_assigned",
    `SELECT p.id,p.company_id,c.legal_name,p.version,p.name,p.status,p.lifecycle_status,p.valid_from,p.valid_until,p.profile_sha256,p.service_lines,p.regions,p.field_provenance,p.capabilities,p.certifications,p.reference_profile,p.commercial_profile,p.approved_at,p.approved_by,
      CASE WHEN jsonb_typeof(p.capabilities::jsonb->'missing')='array' THEN p.capabilities::jsonb->'missing' ELSE '[]'::jsonb END missing_required,
      coalesce((p.capabilities::jsonb->>'completenessPercent')::int,0) completeness_percent
      FROM tender.company_profiles p LEFT JOIN tender.enterprise_company_links c ON c.company_id=p.company_id ORDER BY c.legal_name,p.version DESC`,
  );
  app.post("/api/profiles/:id/activate",{preHandler:[requirePermission(["tender.config.approve","tender.config.self_approve_activate"]),csrf]},async(req,reply)=>{if(!validUuid(req.params.id))return reply.code(400).send({error:"profile_id_invalid"});const expectedHash=String(req.body?.profileSha256||""),confirmation=String(req.body?.confirmation||"");const client=await pool.connect();let companyId;try{await client.query("BEGIN");const profile=(await client.query("SELECT * FROM tender.company_profiles WHERE id=$1 FOR UPDATE",[req.params.id])).rows[0];if(!profile){await client.query("ROLLBACK");return reply.code(404).send({error:"profile_not_found"})}companyId=profile.company_id;if(profile.lifecycle_status!=="READY_FOR_APPROVAL"||profile.profile_sha256!==expectedHash||confirmation!=="Ich bestätige diese konkrete Gesellschaftsprofilversion und ihre Quellen."){await client.query("ROLLBACK");return reply.code(422).send({error:"profile_approval_binding_invalid"})}const missing=Array.isArray(profile.capabilities?.missing)?profile.capabilities.missing:[],commercial=JSON.stringify(profile.commercial_profile||{});if(missing.length||/NOCH ZU PFLEGEN|GESPERRT/i.test(commercial)){await client.query("ROLLBACK");return reply.code(422).send({error:"profile_mandatory_fields_incomplete",missingFields:missing})}await client.query("UPDATE tender.company_profiles SET lifecycle_status='SUPERSEDED' WHERE company_id=$1 AND lifecycle_status='ACTIVE'",[companyId]);await client.query("UPDATE tender.company_profiles SET lifecycle_status='ACTIVE',approved_at=now(),approved_by=$2 WHERE id=$1",[profile.id,req.identity.userId]);await client.query("INSERT INTO tender.company_profile_approvals(company_profile_id,profile_sha256,approved_by,approval_scope) VALUES($1,$2,$3,$4::jsonb)",[profile.id,profile.profile_sha256,req.identity.userId,JSON.stringify({companyId,version:profile.version,serviceLines:profile.service_lines||[]})]);await client.query("INSERT INTO tender.audit_events(actor_id,action,metadata) VALUES($1,'COMPANY_PROFILE_ACTIVATED',$2::jsonb)",[req.identity.userId,JSON.stringify({companyProfileId:profile.id,companyId,version:profile.version,profileSha256:profile.profile_sha256})]);await client.query("COMMIT")}catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}const recheck=await reconcileFinalPreflight({limit:500});return {status:"ACTIVE",companyId,recheck,transmitted:false}});
  list(
    "/api/regions",
    "tender.view_assigned",
    "SELECT id,code,version,name,active FROM tender.region_zones ORDER BY code,version DESC",
  );
  list(
    "/api/matching",
    "tender.view_assigned",
    "SELECT id,version,service_line,cpv_codes,keywords,synonyms,exclusions,weight,semantic_enabled,active FROM tender.matching_rules ORDER BY service_line,version DESC",
  );
  list(
    "/api/score-rules",
    "tender.view_assigned",
    "SELECT id,version,weights,thresholds,hard_gates,active FROM tender.score_configs ORDER BY version DESC",
  );
  const portalManage = (identity) => portalAccessCapabilities(identity).manage;
  const portalRow = async (id) =>
    !validUuid(id)?null:(await pool.query("SELECT * FROM tender.portal_registry WHERE id=$1", [id]))
      .rows[0] || null;
  const activeCredentialForCompany = async (portalId, companyId) =>
    !validUuid(companyId) ? null : (
      await pool.query(
        `SELECT credential.* FROM tender.portal_credential_secrets credential
         JOIN tender.portal_credential_companies scope ON scope.credential_id=credential.id
         WHERE credential.portal_id=$1 AND credential.status='ACTIVE' AND scope.company_id=$2 AND scope.active=true
         ORDER BY credential.version DESC LIMIT 1`,
        [portalId, companyId],
      )
    ).rows[0] || null;
  const safePortalEvent = async (
    portalId,
    actorId,
    action,
    resultCode,
    detail = {},
  ) =>
    pool.query(
      "INSERT INTO tender.portal_connection_events(portal_id,actor_id,action,result_code,safe_detail) VALUES($1,$2,$3,$4,$5::jsonb)",
      [portalId, actorId, action, resultCode, JSON.stringify(detail)],
    );
  const portalHosts = (portal) =>
    [
      portal.canonical_domain,
      ...(portal.allowed_subdomains || []),
      ...(portal.authentication_domains || []),
      ...(portal.download_domains || []),
    ].map((x) => String(x).toLowerCase());
  const safeExternalPortalUrl = (value, portal) => {
    if (!value) return null;
    try {
      return canonicalPortalUrl(
        value,
        portal.canonical_domain,
        portalHosts(portal),
      ).href;
    } catch {
      return null;
    }
  };
  const externalLoginTarget = (portal) => {
    // Authentication navigation is profile-only. Tender document URLs are
    // intentionally excluded: a login-labelled action must never resolve to
    // a download/archive/document endpoint.
    const authenticationEntry = safeExternalPortalUrl(
        portal.authentication_entry_url,
        portal,
      ),
      bidderArea = safeExternalPortalUrl(portal.bidder_area_url, portal);
    if (!authenticationEntry || !bidderArea)
      throw Object.assign(Error("PORTAL_AUTHENTICATION_TARGET_NOT_CONFIGURED"), {
        statusCode: 409,
        code: "PORTAL_AUTHENTICATION_TARGET_NOT_CONFIGURED",
      });
    return {
      externalUrl: authenticationEntry,
      portalLoginUrl: authenticationEntry,
      portalTenderUrl: bidderArea,
      partnerSystemUrl: null,
      expectedPortalHost: new URL(authenticationEntry).hostname.toLowerCase(),
      expectedPartnerHost: null,
    };
  };
  app.get("/api/portal-adapters/catalog", { preHandler: read }, async () => {
    const rows = (
      await pool.query(`SELECT adapter_id,adapter_version,tender.canonical_portal_adapter_validation_status(adapter_validation_status) adapter_validation_status,last_verified_at,last_successful_document_fetch_at,last_error_code,
      count(*)::int registered_hosts,count(*) FILTER(WHERE adapter_enabled)::int enabled_hosts
      FROM tender.portal_registry WHERE adapter_id IS NOT NULL GROUP BY adapter_id,adapter_version,adapter_validation_status,last_verified_at,last_successful_document_fetch_at,last_error_code ORDER BY adapter_id`)
    ).rows;
    const evidence = rows
      .filter(
        (row) =>
          row.adapter_validation_status === "PRODUCTION_VALIDATED" &&
          row.last_successful_document_fetch_at,
      )
      .map((row) => ({
        adapterId: row.adapter_id,
        validationStatus: "PRODUCTION_VALIDATED",
        lastLiveTestAt: row.last_successful_document_fetch_at,
        evidenceId: `${row.adapter_id}:${row.adapter_version}`,
      }));
    return {
      contractVersion: "2.0.0",
      items: adapterCoverageMatrix(evidence),
      registered: rows,
      validationRule:
        "PRODUCTION_VALIDATED requires real verified production evidence",
      externalParticipationEnabled: false,
    };
  });
  const discoverPortals = () =>
    pool.query(
      `WITH domains AS(SELECT DISTINCT lower(split_part(split_part(source_url,'://',2),'/',1)) domain FROM tender.enrichment_documents WHERE fetch_status='PORTALZUGANG_ERFORDERLICH' AND source_url LIKE 'https://%') INSERT INTO tender.portal_registry(display_name,canonical_domain,discovery_source) SELECT initcap(replace(CASE WHEN split_part(domain,'.',1)='www' THEN split_part(domain,'.',2) ELSE split_part(domain,'.',1) END,'-',' ')),domain,'PORTAL_REQUIRED_DOCUMENT' FROM domains WHERE domain<>'' AND domain !~ '(^localhost$|^127\\.|^10\\.|^192\\.168\\.|^172\\.(1[6-9]|2[0-9]|3[01])\\.)' ON CONFLICT(canonical_domain) DO NOTHING`,
    );
  app.get("/api/portals", { preHandler: read }, async (req) => {
    await discoverPortals();
    const manage = portalManage(req.identity),
      permittedCompanies = await accessibleCompanies(req.identity),
      permittedCompanyIds = permittedCompanies.map((row) => row.company_id),
      companyCredentialRows = permittedCompanyIds.length
        ? (
            await pool.query(
              `SELECT credential.portal_id,company.company_id,company.legal_name company_name,
                credential.id credential_id,credential.version credential_version,
                credential.username_masked,credential.internal_label,credential.mfa_method,
                credential.valid_until,credential.created_at credential_created_at,
                credential.account_confirmed,credential.submission_capable,
                session.status session_status,session.expires_at session_expires_at,
                session.verification_status session_verification_status,
                session.session_effective_status
               FROM tender.enterprise_company_links company
               JOIN tender.portal_credential_companies scope
                 ON scope.company_id=company.company_id AND scope.active=true
               JOIN tender.portal_credential_secrets credential
                 ON credential.id=scope.credential_id AND credential.status='ACTIVE'
                 AND (credential.valid_until IS NULL OR credential.valid_until>now())
               LEFT JOIN LATERAL(
                 SELECT status,expires_at,verification_status,
                   tender.portal_session_effective_status(status,expires_at,revoked_at,verification_status) session_effective_status
                 FROM tender.portal_read_sessions session
                 WHERE session.portal_id=credential.portal_id
                   AND session.credential_id=credential.id
                   AND session.company_id=company.company_id
                 ORDER BY session.created_at DESC LIMIT 1
               ) session ON true
               WHERE company.active=true AND company.company_id=ANY($1::uuid[])
               ORDER BY credential.portal_id,company.legal_name,credential.version DESC`,
              [permittedCompanyIds],
            )
          ).rows
        : [],
      rows = (
        await pool.query(`WITH detected AS(
      SELECT lower(split_part(split_part(d.source_url,'://',2),'/',1)) domain,count(DISTINCT e.tender_id)::int tenders,count(*)::int documents
      FROM tender.enrichment_documents d JOIN tender.enrichment_versions e ON e.id=d.enrichment_version_id
      WHERE d.source_url LIKE 'https://%' GROUP BY 1), latest_credential AS(
      SELECT DISTINCT ON(s.portal_id) s.* FROM tender.portal_credential_secrets s WHERE s.status='ACTIVE' ORDER BY s.portal_id,s.version DESC), companies AS(
      SELECT pc.credential_id,jsonb_agg(jsonb_build_object('id',c.company_id,'name',c.legal_name) ORDER BY c.legal_name) items FROM tender.portal_credential_companies pc JOIN tender.enterprise_company_links c ON c.company_id=pc.company_id WHERE pc.active=true GROUP BY pc.credential_id), latest_event AS(
      SELECT DISTINCT ON(portal_id) portal_id,result_code,occurred_at FROM tender.portal_connection_events WHERE action IN ('CONNECTION_TEST','DOCUMENT_TEST','MFA_CONFIRMATION') ORDER BY portal_id,occurred_at DESC), sessions AS(
      SELECT DISTINCT ON(portal_id) portal_id,company_id,status,expires_at,verification_status,
        tender.portal_session_effective_status(status,expires_at,revoked_at,verification_status) session_effective_status
      FROM tender.portal_read_sessions ORDER BY portal_id,created_at DESC), capability AS(
      SELECT profile.portal_id,profile.portal_type,profile.profile_version,profile.evidence_url capability_evidence_url,profile.evidence_label,profile.evidence_verified_at,
        jsonb_object_agg(feature.feature_key,jsonb_build_object('portalSupport',feature.portal_support,'autopilotSupported',feature.autopilot_supported,'activelyConfigured',feature.actively_configured,'productionTested',feature.production_tested,'browserAcceptancePassed',feature.browser_acceptance_passed,'evidenceUrl',feature.evidence_url,'evidenceNote',feature.evidence_note,'verifiedAt',feature.verified_at) ORDER BY feature.feature_key) capability_features
      FROM tender.portal_capability_profiles profile JOIN tender.portal_capability_features feature ON feature.profile_id=profile.id GROUP BY profile.id)
      SELECT p.*,a.mode adapter_mode,a.supported_actions,a.authentication_type,coalesce(d.tenders,0) detected_tenders,coalesce(d.documents,0) affected_documents,c.id IS NOT NULL configured,c.account_confirmed,c.submission_capable,c.username_masked,c.internal_label,c.mfa_method,c.contact_person,c.notes,c.valid_until,c.created_at credential_created_at,coalesce(cs.items,'[]'::jsonb) companies,coalesce(h.login_result,le.result_code) connection_status,tender.canonical_portal_adapter_validation_status(coalesce(h.effective_status,p.adapter_validation_status)) effective_status,h.document_fetch_possible current_document_fetch_possible,h.checked_at live_checked_at,le.occurred_at last_test_at,s.company_id session_company_id,s.status session_status,s.expires_at session_expires_at,s.verification_status session_verification_status,s.session_effective_status,cap.portal_type capability_portal_type,cap.profile_version capability_profile_version,cap.capability_evidence_url,cap.evidence_label capability_evidence_label,cap.evidence_verified_at capability_evidence_verified_at,coalesce(cap.capability_features,'{}'::jsonb) capability_features
      FROM tender.portal_registry p LEFT JOIN tender.portal_adapters a ON a.portal_code=p.adapter_id LEFT JOIN detected d ON d.domain=p.canonical_domain LEFT JOIN latest_credential c ON c.portal_id=p.id LEFT JOIN companies cs ON cs.credential_id=c.id LEFT JOIN latest_event le ON le.portal_id=p.id LEFT JOIN sessions s ON s.portal_id=p.id LEFT JOIN tender.current_portal_health h ON h.portal_id=p.id LEFT JOIN capability cap ON cap.portal_id=p.id ORDER BY p.display_name,p.canonical_domain`)
      ).rows;
    const readiness = (row) => {
      const actions = row.supported_actions || [],
        features = row.capability_features || {},
        adapter = Boolean(row.adapter_enabled && row.adapter_id),
        discovery = Boolean(features.DISCOVERY?.autopilotSupported),
        download = Boolean(features.DOCUMENT_DOWNLOAD?.autopilotSupported),
        authentication = Boolean(features.LOGIN?.autopilotSupported),
        submission = Boolean(features.SUBMISSION?.autopilotSupported),
        submissionPreflight = Boolean(features.SUBMISSION_PREFLIGHT?.autopilotSupported),
        portalSubmission = features.SUBMISSION?.portalSupport || "UNKNOWN",
        account = Boolean(row.configured && row.account_confirmed !== false),
        credentials = Boolean(row.configured),
        session = row.session_effective_status === "ACTIVE",
        mfa = Boolean(row.mfa_required),
        configuredOperationalFeatures = ["DISCOVERY","DOCUMENT_DOWNLOAD","LOGIN","MONITORING"]
          .map(key => features[key])
          .filter(feature => feature?.activelyConfigured),
        capabilityTruthVerified = configuredOperationalFeatures.length > 0 &&
          configuredOperationalFeatures.every(feature => feature.autopilotSupported && feature.productionTested && feature.browserAcceptancePassed);
      let code = "FULLY_CONFIGURED",
        label = "Vollständig eingerichtet",
        tone = "green",
        action = "Keine Aktion erforderlich";
      if (!adapter) {
        code = "ADAPTER_MISSING";
        label = "Portaladapter fehlt";
        tone = "red";
        action = "Validierten Portaladapter bereitstellen";
      } else if (portalSubmission === "NOT_SUPPORTED") {
        code = "SUBMISSION_EXTERNAL_PORTAL";
        label = "Angebotsabgabe erfolgt im verknüpften Vergabeportal";
        tone = "yellow";
        action = "Beschaffungsportal aus der Bekanntmachung verwenden";
      } else if (!account) {
        code = "REGISTRATION_REQUIRED";
        label = "Registrierung erforderlich";
        tone = "yellow";
        action = "Bieterkonto der WB-Gruppe registrieren und bestätigen";
      } else if (!credentials) {
        code = "CREDENTIALS_MISSING";
        label = "Zugangsdaten fehlen";
        tone = "yellow";
        action = "Portalzugang verschlüsselt hinterlegen";
      } else if (portalSubmission === "SUPPORTED" && !submission && submissionPreflight) {
        code = "SUBMISSION_PREFLIGHT_AVAILABLE";
        label = "Submission-Preflight verfügbar; finale Übertragung nicht validiert";
        tone = "yellow";
        action = "Finale Portalübertragung erst nach separater rechtsverbindlicher Produktivvalidierung freigeben";
      } else if (portalSubmission === "SUPPORTED" && !submission) {
        code = "AUTOPILOT_SUBMISSION_NOT_IMPLEMENTED";
        label = "Submission im Tender Autopilot noch nicht implementiert";
        tone = "yellow";
        action =
          "Submission-Adapter als nächste Ausbaustufe implementieren und produktiv validieren";
      } else if (portalSubmission === "UNKNOWN") {
        code = "PORTAL_CAPABILITY_UNVERIFIED";
        label = "Portalfähigkeit noch nicht belegt";
        tone = "yellow";
        action = "Portalfähigkeit autoritativ verifizieren";
      } else if (!capabilityTruthVerified) {
        code = "CAPABILITY_VALIDATION_INCOMPLETE";
        label = "Konfigurierte Portalfähigkeiten nicht vollständig produktiv und im Browser bestätigt";
        tone = "yellow";
        action = "Produktivtest und Browserabnahme je aktivierter Fähigkeit vervollständigen";
      } else if (mfa) {
        code = "MFA_REQUIRED";
        label = "MFA erforderlich";
        tone = "yellow";
        action = "MFA im Managed Browser abschließen";
      } else if (!session) {
        code = "SESSION_EXPIRED";
        label = "Session abgelaufen";
        tone = "yellow";
        action = "Portal erneut anmelden";
      }
      return {
        code,
        label,
        tone,
        action,
        adapter,
        discovery,
        download,
        authentication,
        submission,
        submissionPreflight,
        portalSubmission,
        account,
        credentials,
        session,
        mfa,
        capabilityTruthVerified,
      };
    };
    return {
      items: rows.map((row) => {
        const companyAccesses = permittedCompanies.map((company) => {
            const credential = companyCredentialRows.find(
              (item) =>
                String(item.portal_id) === String(row.id) &&
                String(item.company_id) === String(company.company_id),
            );
            return {
              companyId: company.company_id,
              companyName: company.legal_name,
              configured: Boolean(credential),
              credentialId: credential?.credential_id || null,
              credentialVersion: credential?.credential_version || null,
              usernameMasked: manage
                ? credential?.username_masked || null
                : undefined,
              internalLabel: manage
                ? credential?.internal_label || null
                : undefined,
              mfaMethod: credential?.mfa_method || null,
              validUntil: credential?.valid_until || null,
              createdAt: credential?.credential_created_at || null,
              bidderAccountPresent: Boolean(credential?.account_confirmed),
              readOnly: credential ? !credential.submission_capable : true,
              sessionStatus: credential?.session_status || null,
              sessionValidUntil: credential?.session_expires_at || null,
              sessionVerificationStatus:
                credential?.session_verification_status || null,
              sessionEffectiveStatus:
                credential?.session_effective_status || "RELOGIN_REQUIRED_INACTIVE",
            };
          }),
          configuredAccesses = companyAccesses.filter(
            (access) => access.configured,
          ),
          verifiedSession = companyAccesses.find(
            (access) => access.sessionEffectiveStatus === "ACTIVE",
          ),
          scopedRow = {
            ...row,
            configured: configuredAccesses.length > 0,
            account_confirmed: configuredAccesses.some(
              (access) => access.bidderAccountPresent,
            ),
            submission_capable: configuredAccesses.some(
              (access) => !access.readOnly,
            ),
            session_status: verifiedSession?.sessionStatus || null,
            session_expires_at: verifiedSession?.sessionValidUntil || null,
            session_effective_status:
              verifiedSession?.sessionEffectiveStatus || "RELOGIN_REQUIRED_INACTIVE",
            companies: configuredAccesses.map((access) => ({
              id: access.companyId,
              name: access.companyName,
            })),
          },
          ready = readiness(scopedRow);
        return {
          portalId: row.id,
          portalName: row.display_name,
          portalType:
            row.capability_portal_type ||
            row.adapter_mode ||
            "Nicht klassifiziert",
          domain: row.canonical_domain,
          allowedSubdomains: row.allowed_subdomains,
          authenticationDomains: row.authentication_domains,
          downloadDomains: row.download_domains,
          adapterId: row.adapter_id,
          adapterVersion: row.adapter_version,
          adapterValidationStatus:
            row.effective_status || "UNKNOWN_PORTAL_ADAPTER_REQUIRED",
          historicalAdapterValidationStatus: row.adapter_validation_status,
          adapterEnabled: row.adapter_enabled,
          capabilities: row.capabilities,
          supportedActions: row.supported_actions || [],
          capabilityProfile: {
            version: row.capability_profile_version || 1,
            evidenceUrl: row.capability_evidence_url,
            evidenceLabel: row.capability_evidence_label,
            verifiedAt: row.capability_evidence_verified_at,
            features: row.capability_features || {},
          },
          loginStrategy: row.login_strategy,
          documentStrategy: row.document_strategy,
          detectedTenders: row.detected_tenders,
          affectedDocuments: row.affected_documents,
          accessRequired: row.affected_documents > 0,
          configured: scopedRow.configured,
          bidderAccountPresent: ready.account,
          portalSubmissionSupported: ready.portalSubmission,
          submissionSupported: ready.submission,
          authenticationSupported: ready.authentication,
          discoverySupported: ready.discovery,
          documentDownloadSupported: ready.download,
          portalReadiness: ready,
          connectionFunctional:
            ready.session && row.effective_status === "PRODUCTION_VALIDATED",
          documentFetchPossible:
            ready.session && row.current_document_fetch_possible === true,
          lastSuccessfulLogin: null,
          lastSuccessfulDocumentFetch: null,
          lastSuccessfulSubmissionPreflight:
            row.last_successful_submission_preflight_at,
          lastVerifiedAt: row.live_checked_at || row.last_verified_at,
          lastError:
            row.effective_status === "PRODUCTION_VALIDATED"
              ? null
              : row.connection_status || row.last_error_code,
          mfaRequired: row.mfa_required,
          captchaRequired: row.captcha_required,
          passwordExpired: row.password_expired,
          accountLocked: row.account_locked,
          sessionStatus: scopedRow.session_status,
          sessionValidUntil: scopedRow.session_expires_at,
          companies: scopedRow.companies,
          connectionStatus: row.effective_status || row.connection_status,
          credential: null,
          contactPerson: null,
          notes: null,
          canManage: manage,
          readOnly: !scopedRow.submission_capable,
          companyAccesses,
        };
      }),
      canManage: manage,
      connectorContractVersion: "3.0.0",
      externalWritesEnabled: false,
    };
  });
  const PORTAL_SUBMISSION_GRANT_PHRASE =
    "Ich bestätige, dass dieser bestehende Portalzugang für elektronische Angebotsabgaben der ausgewählten Gesellschaft verwendet werden darf.";
  const PORTAL_SUBMISSION_REVOKE_PHRASE =
    "Ich bestätige, dass die Senderechte dieses Portalzugangs für die ausgewählte Gesellschaft deaktiviert werden sollen.";
  app.get(
    "/api/portal-submission-access",
    { preHandler: read },
    async (req) => {
      const canGrant =
        req.identity.permissions.includes("tender.admin") ||
        (req.identity.permissions.includes("tender.portal.manage") &&
          req.identity.permissions.includes("tender.submission.approve"));
      const rows = (
        await pool.query(`SELECT portal.id portal_id,portal.display_name portal_name,portal.canonical_domain,tender.canonical_portal_adapter_validation_status(portal.adapter_validation_status) adapter_validation_status,adapter.portal_code,credential.id credential_id,credential.account_confirmed,credential.read_only,credential.submission_capable,credential.mfa_method,portal.mfa_required,portal.last_successful_login_at,company.company_id,link.legal_name company_name,access_grant.id grant_id,access_grant.scope grant_scope,access_grant.granted_at,access_grant.audit_id,cap.portal_support,cap.autopilot_supported,cap.actively_configured,cap.production_tested,cap.browser_acceptance_passed,cap.evidence_note,cap.verified_at capability_verified_at
    FROM tender.portal_registry portal LEFT JOIN tender.portal_adapters adapter ON adapter.portal_code=portal.adapter_id LEFT JOIN tender.portal_credential_secrets credential ON credential.portal_id=portal.id AND credential.status='ACTIVE' AND (credential.valid_until IS NULL OR credential.valid_until>now()) LEFT JOIN tender.portal_credential_companies company ON company.credential_id=credential.id AND company.active=true LEFT JOIN tender.enterprise_company_links link ON link.company_id=company.company_id LEFT JOIN LATERAL(SELECT * FROM tender.portal_submission_access_grants access_grant WHERE access_grant.portal_id=portal.id AND access_grant.credential_id=credential.id AND access_grant.company_id=company.company_id AND access_grant.status='ACTIVE' ORDER BY access_grant.granted_at DESC LIMIT 1) access_grant ON true LEFT JOIN LATERAL(SELECT feature.* FROM tender.portal_capability_profiles profile JOIN tender.portal_capability_features feature ON feature.profile_id=profile.id AND feature.feature_key='SUBMISSION' WHERE profile.portal_id=portal.id ORDER BY profile.profile_version DESC LIMIT 1) cap ON true WHERE adapter.portal_code IN('deutsche-evergabe','vergabe24','dtvp','rib-meinauftrag','evergabe-online-bund','evergabe-bayern','cosinex-vmp-public') ORDER BY portal.display_name,link.legal_name,credential.version DESC`)
      ).rows;
      return {
        items: rows
          .filter(
            (row) =>
              !row.company_id ||
              req.identity.permissions.includes("tender.admin") ||
              req.identity.companyIds.includes(String(row.company_id)),
          )
          .map((row) => {
            const capabilityReady = row.portal_support === "SUPPORTED" && row.autopilot_supported === true && row.actively_configured === true && row.production_tested === true && row.browser_acceptance_passed === true && row.adapter_validation_status === "PRODUCTION_VALIDATED" && submissionAdapters[row.portal_code]?.productionValidated === true;
            return {
            ...row, capabilityReady,
            accountPresent: row.account_confirmed === true,
            credentialPresent: Boolean(row.credential_id),
            submissionGranted: Boolean(row.grant_id),
            permissionStatus: !capabilityReady
              ? "Nicht verfügbar – Submission-Adapter nicht produktiv validiert"
              : !row.account_confirmed
              ? "Registrierung erforderlich"
              : !row.credential_id
                ? "Zugangsdaten fehlen"
                : row.grant_id
                  ? "Submission freigegeben"
                  : "Nur Lesen",
            canGrant:
              canGrant &&
              Boolean(row.credential_id) &&
              Boolean(row.company_id) &&
              !row.grant_id && capabilityReady,
            canRevoke: canGrant && Boolean(row.grant_id),
          }}),
        confirmationPhrase: PORTAL_SUBMISSION_GRANT_PHRASE,
        revokeConfirmationPhrase: PORTAL_SUBMISSION_REVOKE_PHRASE,
        canGrant,
        external_submission_enabled: false,
        transmitted: false,
      };
    },
  );
  const eligibilityLabels = {
    SUBMISSION_READY: "Bieterzugang einsatzbereit",
    DOCUMENT_ACCESS_ONLY: "Nur Dokumentzugriff bestätigt",
    ACCOUNT_FOR_OTHER_COMPANY: "Zugang gehört einer anderen Gesellschaft",
    MULTI_COMPANY_SELECTION_AVAILABLE:
      "Zielgesellschaft im Mehrgesellschaftskonto auswählbar",
    REGISTRATION_REQUIRED: "Bieterzugang für diese Gesellschaft erforderlich",
    CREDENTIALS_MISSING: "Zugangsdaten fehlen",
    SUBMISSION_PERMISSION_REQUIRED: "Interne Submission-Freigabe fehlt",
    NOT_AUTHORITATIV_VERIFIED: "Noch nicht autoritativ geprüft",
  };
  app.get(
    "/api/portal-company-eligibility",
    { preHandler: read },
    async (req) => {
      const portal = String(req.query?.portal || ""),
        company = String(req.query?.company || ""),
        status = String(req.query?.status || ""),
        submission = String(req.query?.submission || ""),
        registration = String(req.query?.registration || "");
      const allowed = req.identity.permissions.includes("tender.admin")
        ? null
        : req.identity.companyIds;
      const rows = (
        await pool.query(
          `SELECT * FROM tender.current_portal_company_eligibility WHERE ($1='' OR portal_id::text=$1) AND ($2='' OR company_id::text=$2) AND ($3='' OR eligibility_status=$3) AND ($4='' OR submission_possible=($4='true')) AND ($5='' OR (eligibility_status='REGISTRATION_REQUIRED')=($5='true')) ORDER BY portal_name,company_name`,
          [portal, company, status, submission, registration],
        )
      ).rows.filter(
        (row) => !allowed || allowed.includes(String(row.company_id)),
      );
      const counts = rows.reduce(
        (all, row) => (
          (all[row.eligibility_status] =
            (all[row.eligibility_status] || 0) + 1),
          all
        ),
        {},
      );
      return {
        items: rows.map((row) => ({
          ...row,
          status_label:
            eligibilityLabels[row.eligibility_status] ||
            "Noch nicht autoritativ geprüft",
        })),
        counts,
        total: rows.length,
        statusLabels: eligibilityLabels,
        externalWrite: false,
        transmitted: false,
      };
    },
  );
  app.get(
    "/api/tenders/:id/portal-company-eligibility",
    { preHandler: read },
    async (req, reply) => {
      if (!(await visibleTender(req, reply, req.params.id))) return;
      const company = String(req.query?.company || "");
      if (!company) return reply.code(400).send({ error: "company_required" });
      if (
        !req.identity.permissions.includes("tender.admin") &&
        !req.identity.companyIds.includes(company)
      )
        return reply.code(403).send({ error: "company_scope_forbidden" });
      const row = (
        await pool.query(
          `WITH candidate AS(
            SELECT DISTINCT p.id,e.version
            FROM tender.enrichment_documents d
            JOIN tender.enrichment_versions e ON e.id=d.enrichment_version_id
            JOIN tender.portal_registry p ON
              nullif(d.provenance->>'portalId','')=p.id::text OR
              lower(split_part(split_part(d.source_url,'://',2),'/',1))=p.canonical_domain OR
              lower(split_part(split_part(d.source_url,'://',2),'/',1))=ANY(p.allowed_subdomains)
            WHERE e.tender_id=$1
          )
          SELECT eligibility.* FROM candidate
          JOIN tender.current_portal_company_eligibility eligibility
            ON eligibility.portal_id=candidate.id AND eligibility.company_id=$2
          ORDER BY CASE eligibility.eligibility_status
            WHEN 'SUBMISSION_READY' THEN 1
            WHEN 'MULTI_COMPANY_SELECTION_AVAILABLE' THEN 2
            WHEN 'ACCOUNT_FOR_OTHER_COMPANY' THEN 3
            WHEN 'SUBMISSION_PERMISSION_REQUIRED' THEN 4
            WHEN 'REGISTRATION_REQUIRED' THEN 5
            WHEN 'DOCUMENT_ACCESS_ONLY' THEN 6
            ELSE 7 END,
            candidate.version DESC
          LIMIT 1`,
          [req.params.id, company],
        )
      ).rows[0];
      if (!row)
        return {
          status_label:
            "Portal für dieses Verfahren noch nicht autoritativ zugeordnet",
          eligibility_status: "NOT_AUTHORITATIV_VERIFIED",
          externalWrite: false,
        };
      return {
        ...row,
        status_label:
          eligibilityLabels[row.eligibility_status] ||
          "Noch nicht autoritativ geprüft",
        recommendation:
          row.eligibility_status === "ACCOUNT_FOR_OTHER_COMPANY" ||
          row.eligibility_status === "REGISTRATION_REQUIRED"
            ? `Vor Angebotsabgabe eigenen oder geeigneten Bieterzugang für ${row.company_name} einrichten.`
            : row.eligibility_status === "SUBMISSION_PERMISSION_REQUIRED"
              ? "Interne Submission-Freigabe einholen."
              : "Portalidentität vor der Angebotsabgabe prüfen.",
        externalWrite: false,
      };
    },
  );
  app.post(
    "/api/portal-access/:portalId/submission-grants",
    { preHandler: [requirePermission("tender.submission.approve"), csrf] },
    async (req, reply) => {
      if (
        !req.identity.permissions.includes("tender.admin") &&
        !req.identity.permissions.includes("tender.portal.manage")
      )
        return reply.code(403).send({ error: "forbidden" });
      const portalId = String(req.params.portalId),
        credentialId = String(req.body?.credentialId || ""),
        companyId = String(req.body?.companyId || ""),
        scope = String(
          req.body?.scope || "SUBMISSION_PREFLIGHT_AND_FINAL_SUBMISSION",
        );
      if (req.body?.confirmation !== PORTAL_SUBMISSION_GRANT_PHRASE)
        return reply
          .code(409)
          .send({
            error: "explicit_confirmation_required",
            message:
              "Die verbindliche Bestätigung für die Submission-Freischaltung fehlt.",
          });
      if (
        ![
          "SUBMISSION_PREFLIGHT_ONLY",
          "SUBMISSION_PREFLIGHT_AND_FINAL_SUBMISSION",
        ].includes(scope)
      )
        return reply.code(400).send({ error: "scope_invalid" });
      if (
        !req.identity.permissions.includes("tender.admin") &&
        !req.identity.companyIds.includes(companyId)
      )
        return reply.code(403).send({ error: "company_scope_forbidden" });
      const credential = (
        await pool.query(
          "SELECT credential.id,credential.account_confirmed,company.company_id FROM tender.portal_credential_secrets credential JOIN tender.portal_credential_companies company ON company.credential_id=credential.id WHERE credential.id=$1 AND credential.portal_id=$2 AND credential.status='ACTIVE' AND company.company_id=$3 AND company.active=true",
          [credentialId, portalId, companyId],
        )
      ).rows[0];
      if (!credential)
        return reply
          .code(404)
          .send({ error: "portal_credential_scope_not_found" });
      if (!credential.account_confirmed)
        return reply
          .code(409)
          .send({
            error: "bidder_account_not_confirmed",
            message: "Das Bieterkonto ist noch nicht bestätigt.",
          });
      const capability = (await pool.query(`SELECT portal.adapter_id,tender.canonical_portal_adapter_validation_status(portal.adapter_validation_status) adapter_validation_status,feature.portal_support,feature.autopilot_supported,feature.actively_configured,feature.production_tested,feature.browser_acceptance_passed
        FROM tender.portal_registry portal LEFT JOIN tender.portal_capability_profiles profile ON profile.portal_id=portal.id LEFT JOIN tender.portal_capability_features feature ON feature.profile_id=profile.id AND feature.feature_key='SUBMISSION'
        WHERE portal.id=$1 ORDER BY profile.profile_version DESC LIMIT 1`, [portalId])).rows[0];
      const capabilityReady = capability?.portal_support === "SUPPORTED" && capability.autopilot_supported === true && capability.actively_configured === true && capability.production_tested === true && capability.browser_acceptance_passed === true && capability.adapter_validation_status === "PRODUCTION_VALIDATED" && submissionAdapters[capability.adapter_id]?.productionValidated === true;
      if (!capabilityReady)
        return reply.code(409).send({ error: "submission_adapter_not_production_validated", message: "Senderechte können erst aktiviert werden, wenn die SUBMISSION-Fähigkeit dieses konkreten Adapters produktiv validiert, aktiv konfiguriert und browserabgenommen ist. Die globale externe Abgabesperre bleibt unabhängig davon aktiv." });
      const auditId = `PSG-${crypto.randomUUID()}`,
        client = await pool.connect();
      try {
        await client.query("BEGIN");
        const grant = (
          await client.query(
            "INSERT INTO tender.portal_submission_access_grants(portal_id,credential_id,company_id,scope,granted_by,audit_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(portal_id,credential_id,company_id,status) DO UPDATE SET scope=excluded.scope,granted_by=excluded.granted_by,granted_at=now(),audit_id=excluded.audit_id RETURNING id,scope,granted_at,audit_id",
            [
              portalId,
              credentialId,
              companyId,
              scope,
              req.identity.userId,
              auditId,
            ],
          )
        ).rows[0];
        await client.query(
          "INSERT INTO tender.audit_events(actor_id,action,metadata) VALUES($1,'PORTAL_SUBMISSION_ACCESS_GRANTED',$2::jsonb)",
          [
            req.identity.userId,
            JSON.stringify({
              portalId,
              credentialId,
              companyId,
              scope,
              grantId: grant.id,
              auditId: grant.audit_id,
              passwordChanged: false,
              credentialCopied: false,
              externalSubmissionEnabled: false,
              transmitted: false,
            }),
          ],
        );
        await client.query("COMMIT");
        return reply.code(201).send({ ...grant, submissionGranted: true, external_submission_enabled: false, transmitted: false });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );
  app.post(
    "/api/portal-access/:portalId/submission-grants/revoke",
    { preHandler: [requirePermission("tender.submission.approve"), csrf] },
    async (req, reply) => {
      if (!req.identity.permissions.includes("tender.admin") && !req.identity.permissions.includes("tender.portal.manage"))
        return reply.code(403).send({ error: "forbidden" });
      const portalId = String(req.params.portalId), credentialId = String(req.body?.credentialId || ""), companyId = String(req.body?.companyId || ""), confirmation = String(req.body?.confirmation || "");
      if (confirmation !== PORTAL_SUBMISSION_REVOKE_PHRASE)
        return reply.code(409).send({ error: "explicit_confirmation_required", message: "Die verbindliche Bestätigung zur Deaktivierung der Senderechte fehlt." });
      if (!req.identity.permissions.includes("tender.admin") && !req.identity.companyIds.includes(companyId))
        return reply.code(403).send({ error: "company_scope_forbidden" });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const grant = (await client.query(`UPDATE tender.portal_submission_access_grants AS access_grant SET status='REVOKED',revoked_by=$4,revoked_at=now()
          WHERE access_grant.portal_id=$1 AND access_grant.credential_id=$2 AND access_grant.company_id=$3 AND access_grant.status='ACTIVE'
          AND EXISTS(SELECT 1 FROM tender.portal_credential_secrets credential JOIN tender.portal_credential_companies scope ON scope.credential_id=credential.id AND scope.company_id=$3 AND scope.active=true WHERE credential.id=$2 AND credential.portal_id=$1)
          RETURNING id,audit_id,revoked_at`, [portalId, credentialId, companyId, req.identity.userId])).rows[0];
        if (!grant) { await client.query("ROLLBACK"); return reply.code(404).send({ error: "portal_submission_grant_scope_not_found" }); }
        const auditId = `PSR-${crypto.randomUUID()}`;
        await client.query("INSERT INTO tender.audit_events(actor_id,action,metadata) VALUES($1,'PORTAL_SUBMISSION_ACCESS_REVOKED',$2::jsonb)", [req.identity.userId, JSON.stringify({ portalId, credentialId, companyId, grantId: grant.id, priorAuditId: grant.audit_id, auditId, externalSubmissionEnabled: false, transmitted: false })]);
        await client.query("COMMIT");
        return { status: "REVOKED", revokedAt: grant.revoked_at, auditId, external_submission_enabled: false, transmitted: false };
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    },
  );
  app.get(
    "/api/portal-access/:portalId/scoped-account",
    { preHandler: read },
    async (req, reply) => {
      const portalId = String(req.params.portalId), credentialId = String(req.query?.credential || ""), companyId = String(req.query?.company || ""), tenderId = String(req.query?.tender || ""), lotKey = String(req.query?.lot || "");
      if (![portalId, credentialId, companyId, tenderId].every(validUuid))
        return reply.code(400).send({ error: "complete_portal_account_scope_required" });
      if (!(await visibleTender(req, reply, tenderId))) return;
      const companies = await accessibleCompanies(req.identity);
      if (!companies.some((company) => String(company.company_id) === companyId))
        return reply.code(403).send({ error: "company_scope_forbidden" });
      const registeredScope = await requireRegisteredScope(reply, tenderId, companyId);
      if (!registeredScope) return;
      if (String(registeredScope.portal_id) !== portalId || String(registeredScope.credential_id) !== credentialId)
        return reply.code(404).send({ error: "scoped_portal_account_not_found" });
      const row = (await pool.query(`SELECT portal.id portal_id,portal.display_name portal_name,portal.canonical_domain,portal.adapter_id,portal.adapter_version,tender.canonical_portal_adapter_validation_status(portal.adapter_validation_status) adapter_validation_status,adapter.name adapter_name,
          credential.id credential_id,credential.version credential_version,credential.username_masked,credential.account_confirmed,credential.submission_capable,credential.read_only,company.legal_name company_name,
          context.id submission_context_id,context.tender_id,context.company_id,context.lot_key,access_grant.id grant_id,access_grant.scope grant_scope,access_grant.granted_at,access_grant.audit_id grant_audit_id,
          session.last_verified_at,session.verification_status,session.expires_at session_expires_at,session.session_effective_status,identity_evidence.verified_at identity_verified_at,
          feature.portal_support,feature.autopilot_supported,feature.actively_configured,feature.production_tested,feature.browser_acceptance_passed,feature.evidence_note,feature.verified_at capability_verified_at
        FROM tender.submission_contexts context
        JOIN tender.portal_registry portal ON portal.id=context.portal_id
        JOIN tender.portal_adapters adapter ON adapter.portal_code=portal.adapter_id
        JOIN tender.portal_credential_secrets credential ON credential.id=$2 AND credential.portal_id=portal.id AND credential.status='ACTIVE' AND (credential.valid_until IS NULL OR credential.valid_until>now())
        JOIN tender.portal_credential_companies credential_scope ON credential_scope.credential_id=credential.id AND credential_scope.company_id=context.company_id AND credential_scope.active=true
        JOIN tender.enterprise_company_links company ON company.company_id=context.company_id AND company.active=true
        LEFT JOIN LATERAL(SELECT * FROM tender.portal_submission_access_grants WHERE portal_id=portal.id AND credential_id=credential.id AND company_id=context.company_id AND status='ACTIVE' ORDER BY granted_at DESC LIMIT 1) access_grant ON true
        LEFT JOIN LATERAL(SELECT last_verified_at,verification_status,expires_at,tender.portal_session_effective_status(status,expires_at,revoked_at,verification_status) session_effective_status FROM tender.portal_read_sessions WHERE portal_id=portal.id AND credential_id=credential.id AND company_id=context.company_id ORDER BY created_at DESC LIMIT 1) session ON true
        LEFT JOIN LATERAL(SELECT verified_at FROM tender.portal_account_identity_evidence WHERE portal_id=portal.id AND credential_id=credential.id AND authoritative=true AND (valid_until IS NULL OR valid_until>now()) ORDER BY verified_at DESC LIMIT 1) identity_evidence ON true
        LEFT JOIN LATERAL(SELECT feature.* FROM tender.portal_capability_profiles profile JOIN tender.portal_capability_features feature ON feature.profile_id=profile.id AND feature.feature_key='SUBMISSION' WHERE profile.portal_id=portal.id ORDER BY profile.profile_version DESC LIMIT 1) feature ON true
        WHERE context.tender_id=$1 AND context.portal_id=$3 AND context.company_id=$4 AND context.lot_key=$5
        ORDER BY context.created_at DESC LIMIT 1`, [tenderId, credentialId, portalId, companyId, lotKey])).rows[0];
      if (!row) return reply.code(404).send({ error: "scoped_portal_account_not_found" });
      const adapterImplemented = submissionAdapters[row.adapter_id]?.productionValidated === true;
      const capabilityReady = row.portal_support === "SUPPORTED" && row.autopilot_supported === true && row.actively_configured === true && row.production_tested === true && row.browser_acceptance_passed === true && row.adapter_validation_status === "PRODUCTION_VALIDATED" && adapterImplemented;
      const accountMode = row.grant_id ? "SEND_RIGHTS_GRANTED" : row.submission_capable ? "OFFER_PREPARATION_WRITE" : "READ_ONLY";
      const canManage = req.identity.permissions.includes("tender.admin") || (req.identity.permissions.includes("tender.portal.manage") && req.identity.permissions.includes("tender.submission.approve"));
      return {
        ...row,
        username_masked: canManage ? row.username_masked : undefined,
        accountMode,
        effectiveMode: row.session_effective_status !== "ACTIVE" ? "RELOGIN_REQUIRED" : capabilityReady && row.grant_id ? "SEND_RIGHTS_EFFECTIVE_AS_PREREQUISITE" : capabilityReady ? accountMode : "UNAVAILABLE_ADAPTER_CONFIGURATION_REQUIRED",
        reLoginRequired: row.session_effective_status !== "ACTIVE",
        capabilityReady,
        adapterImplemented,
        canActivate: canManage && capabilityReady && !row.grant_id && row.account_confirmed === true,
        canDeactivate: canManage && Boolean(row.grant_id),
        activationConfirmationPhrase: PORTAL_SUBMISSION_GRANT_PHRASE,
        revocationConfirmationPhrase: PORTAL_SUBMISSION_REVOKE_PHRASE,
        safeNextSteps: capabilityReady ? ["Bieteridentität und letzte Accountvalidierung prüfen", "Tenderbezogene finale Freigabe separat einholen", "Globales serverseitiges Gate separat prüfen"] : ["SUBMISSION-Capability des konkreten Adapters implementieren", "Schreib- und Receipt-Pfad ohne externe Übermittlung intern validieren", "Produktivtest und Browserabnahme dokumentieren"],
        globalGate: { external_submission_enabled: false, environmentOverride: false, bindingEndpointsHttpStatus: 423, transmitted: false },
      };
    },
  );
  app.get(
    "/api/portal-access/:portalId/scoped-adapter",
    { preHandler: read },
    async (req, reply) => {
      const portalId = String(req.params.portalId), companyId = String(req.query?.company || ""), tenderId = String(req.query?.tender || ""), lotKey = String(req.query?.lot || "");
      if (![portalId, companyId, tenderId].every(validUuid)) return reply.code(400).send({ error: "complete_portal_adapter_scope_required" });
      if (!(await visibleTender(req, reply, tenderId))) return;
      const companies = await accessibleCompanies(req.identity);
      if (!companies.some((company) => String(company.company_id) === companyId)) return reply.code(403).send({ error: "company_scope_forbidden" });
      const registeredScope = await requireRegisteredScope(reply, tenderId, companyId);
      if (!registeredScope) return;
      if (String(registeredScope.portal_id) !== portalId)
        return reply.code(404).send({ error: "scoped_portal_adapter_not_found" });
      const row = (await pool.query(`SELECT context.id submission_context_id,context.tender_id,context.company_id,context.lot_key,portal.id portal_id,portal.display_name portal_name,portal.canonical_domain,portal.adapter_id,portal.adapter_version,tender.canonical_portal_adapter_validation_status(portal.adapter_validation_status) adapter_validation_status,adapter.name adapter_name,feature.portal_support,feature.autopilot_supported,feature.actively_configured,feature.production_tested,feature.browser_acceptance_passed,feature.evidence_note,feature.verified_at capability_verified_at
        FROM tender.submission_contexts context JOIN tender.portal_registry portal ON portal.id=context.portal_id JOIN tender.portal_adapters adapter ON adapter.portal_code=portal.adapter_id
        LEFT JOIN LATERAL(SELECT feature.* FROM tender.portal_capability_profiles profile JOIN tender.portal_capability_features feature ON feature.profile_id=profile.id AND feature.feature_key='SUBMISSION' WHERE profile.portal_id=portal.id ORDER BY profile.profile_version DESC LIMIT 1) feature ON true
        WHERE context.tender_id=$1 AND context.portal_id=$2 AND context.company_id=$3 AND context.lot_key=$4 ORDER BY context.created_at DESC LIMIT 1`, [tenderId, portalId, companyId, lotKey])).rows[0];
      if (!row) return reply.code(404).send({ error: "scoped_portal_adapter_not_found" });
      const adapterImplemented = submissionAdapters[row.adapter_id]?.productionValidated === true;
      return { ...row, adapterImplemented, capabilityReady: row.portal_support === "SUPPORTED" && row.autopilot_supported === true && row.actively_configured === true && row.production_tested === true && row.browser_acceptance_passed === true && row.adapter_validation_status === "PRODUCTION_VALIDATED" && adapterImplemented, safeNextSteps: ["SUBMISSION-Capability des konkreten Adapters implementieren", "Schreib- und Receipt-Pfad ohne externe Übermittlung intern validieren", "Produktivtest und Browserabnahme dokumentieren"], globalGate: { external_submission_enabled: false, environmentOverride: false, bindingEndpointsHttpStatus: 423, transmitted: false } };
    },
  );
  app.get(
    "/api/portal-access/companies",
    { preHandler: requirePermission(["tender.portal.manage", "tender.admin"]) },
    async (req) => ({
      items: (await accessibleCompanies(req.identity)).map((company) => ({
        id: company.company_id,
        name: company.legal_name,
      })),
    }),
  );
  app.get(
    "/api/portal-access/for-tender/:tenderId",
    { preHandler: read },
    async (req, reply) => {
      if (!(await visibleTender(req, reply, req.params.tenderId))) return;
      const requestedCompany = String(req.query?.company || "");
      if (!validUuid(requestedCompany))
        return reply.code(400).send({ error: "company_required" });
      const permittedCompanies = await accessibleCompanies(req.identity);
      if (!permittedCompanies.some(row => String(row.company_id) === requestedCompany))
        return reply.code(403).send({ error: "company_scope_forbidden" });
      const registeredScope = await requireRegisteredScope(
        reply,
        req.params.tenderId,
        requestedCompany,
      );
      if (!registeredScope) return;
      await discoverPortals();
      const rows = (
        await pool.query(
          `WITH latest_enrichment AS(
        SELECT id,source_code,source_url FROM tender.enrichment_versions WHERE tender_id=$1 AND historical=false ORDER BY version DESC LIMIT 1
      ), affected AS(
        SELECT d.*,p.id portal_id,p.display_name portal_name,p.canonical_domain,p.allowed_subdomains,p.authentication_domains,p.download_domains,p.login_path,p.authentication_entry_url,p.bidder_area_url,p.login_strategy,p.document_strategy,p.capabilities,p.last_error_code,p.last_successful_login_at,p.last_successful_document_fetch_at,p.mfa_required,p.password_expired,p.account_locked,
          EXISTS(SELECT 1 FROM tender.portal_credential_secrets c WHERE c.id=$4 AND c.portal_id=p.id AND c.status='ACTIVE' AND c.revoked_at IS NULL AND (c.valid_until IS NULL OR c.valid_until>now())
            AND EXISTS(SELECT 1 FROM tender.portal_credential_companies pc WHERE pc.credential_id=c.id AND pc.company_id=$2::uuid AND pc.active=true)) configured,
          s.status session_status,s.expires_at session_expires_at,s.verification_status session_verification_status,s.session_effective_status
        FROM latest_enrichment e JOIN tender.enrichment_documents d ON d.enrichment_version_id=e.id
        JOIN tender.portal_registry p ON p.id=$3 AND ((nullif(d.provenance->>'portalId','') IS NOT NULL AND d.provenance->>'portalId'=p.id::text)
          OR (nullif(d.provenance->>'portalId','') IS NULL AND (
            lower(coalesce(d.provenance->>'targetPortal',''))=p.canonical_domain
            OR lower(coalesce(d.provenance->>'targetPortal',''))=ANY(p.allowed_subdomains)
            OR lower(split_part(split_part(d.source_url,'://',2),'/',1))=p.canonical_domain
            OR lower(split_part(split_part(d.source_url,'://',2),'/',1))=ANY(p.allowed_subdomains))))
        LEFT JOIN LATERAL(SELECT x.status,x.expires_at,x.verification_status,tender.portal_session_effective_status(x.status,x.expires_at,x.revoked_at,x.verification_status) session_effective_status FROM tender.portal_read_sessions x
          JOIN tender.portal_credential_secrets c ON c.id=x.credential_id AND c.status='ACTIVE' AND (c.valid_until IS NULL OR c.valid_until>now())
          WHERE x.portal_id=p.id AND x.credential_id=$4 AND x.company_id=$2::uuid
            AND EXISTS(SELECT 1 FROM tender.portal_credential_companies pc WHERE pc.credential_id=c.id AND pc.company_id=$2::uuid AND pc.active=true)
          ORDER BY x.created_at DESC LIMIT 1)s ON true
      )
      SELECT portal_id,portal_name,coalesce(nullif(max(provenance->>'targetPortal'),''),max(canonical_domain)) domain,max(canonical_domain) canonical_domain,
        (jsonb_agg(allowed_subdomains)->0) allowed_subdomains,(jsonb_agg(authentication_domains)->0) authentication_domains,(jsonb_agg(download_domains)->0) download_domains,
        max(provenance->>'membershipStatus') membership_status,max(provenance->>'partnerSystem') partner_system,max(provenance->>'requestEffect') request_effect,
        max(login_path) portal_url,max(authentication_entry_url) authentication_entry_url,max(bidder_area_url) bidder_area_url,max(login_strategy) login_strategy,max(document_strategy) document_strategy,
        bool_or('PUBLIC_DOCUMENTS_POSSIBLE'=ANY(capabilities) OR login_strategy IN('PUBLIC_DOCUMENT_ACCESS','SOURCE_RESOLVER','RESOLVER_ONLY')) public_document_access,
        max(source_url) FILTER(WHERE document_type='TENDER_DOCUMENT' AND source_url !~* '\\.(zip|pdf|xlsx?|docx?)([?;]|$)') portal_open_candidate,
        max(retrieved_at) last_attempt,
        max(session_status) session_status,min(session_expires_at) session_expires_at,max(session_verification_status) session_verification_status,max(session_effective_status) session_effective_status,
        count(*)::int affected_documents,
        bool_or(configured) configured,
        CASE
          WHEN max(provenance->>'accessStatus')='EXTERNAL_DOCUMENT_REQUEST_REQUIRED' THEN 'EXTERNAL_DOCUMENT_REQUEST_REQUIRED'
          WHEN NOT bool_or(configured) THEN 'CREDENTIALS_NOT_CONFIGURED'
          WHEN max(provenance->>'accessStatus')='PARTNER_SYSTEM_LOGIN_REQUIRED' THEN 'LOGIN_REQUIRED'
          WHEN max(fetch_status)='EXTERNAL_DOCUMENT_REQUEST_REQUIRED' OR max(resolution_status)='EXTERNAL_DOCUMENT_REQUEST_REQUIRED' THEN 'EXTERNAL_DOCUMENT_REQUEST_REQUIRED'
          WHEN max(resolution_status)='DOCUMENT_NOT_AVAILABLE' OR max(fetch_status)='DOKUMENT_NICHT_ÖFFENTLICH_ZUGÄNGLICH' THEN 'DOCUMENT_NOT_FOUND'
          WHEN bool_or(session_effective_status='ACTIVE') THEN 'DOWNLOAD_LINK_UNRESOLVED'
          WHEN bool_and(session_status IS NULL) THEN 'SESSION_MISSING'
          ELSE 'SESSION_EXPIRED' END access_status,
        jsonb_agg(jsonb_build_object('documentId',id,'sourceDocumentId',coalesce(provenance->>'tenderId',filename),'filename',filename,'sourceUrl',source_url,'downloadStatus',resolution_status,'fetchStatus',fetch_status,'parserStatus',parser,'mimeType',mime_type,'lastAttempt',retrieved_at) ORDER BY filename) affected_document_items
      FROM affected GROUP BY portal_id,portal_name ORDER BY portal_name`,
          [req.params.tenderId, requestedCompany, registeredScope.portal_id, registeredScope.credential_id],
        )
      ).rows;
      const queues =
          (
            await pool.query(
            `SELECT DISTINCT ON(portal_id) portal_id,missing_calculation_inputs,next_attempt_at,error_code,safe_error_code,error_detail_safe,blocking_reason,status,current_step,next_step,started_at,heartbeat_at,finished_at,document_resolution_status,documents_found,documents_downloaded,documents_analyzed
             FROM tender.autopilot_queue WHERE tender_id=$1
               AND company_id=$2::uuid AND ($3='' OR coalesce(lot_key,'')=$3)
               AND portal_id IS NOT NULL
               AND action_type NOT IN('TEST_PORTAL_CONNECTION','TEST_DOCUMENT_FETCH','START_PORTAL_AUTHENTICATION')
             ORDER BY portal_id,created_at DESC`,
            [req.params.tenderId,requestedCompany,String(req.query?.lot||"")],
          )
          ).rows,
        queueForPortal = (portalId) =>
          queues.find((item) => String(item.portal_id) === String(portalId)) || {};
      const tender =
        (
          await pool.query(
            "SELECT source_code,source_url FROM tender.tenders WHERE id=$1",
            [req.params.tenderId],
          )
        ).rows[0] || {};
      const policy =
        (
          await pool.query(
            "SELECT id,policy_version,audit_id FROM tender.governance_policies WHERE policy_type='GLOBAL_DOCUMENT_REQUEST_APPROVAL' AND status='ACTIVE' ORDER BY policy_version DESC LIMIT 1",
          )
        ).rows[0] || null;
      const registrations = (
        await pool.query(
          "SELECT portal_id,lot_key,status,cost_amount,cost_currency,bidder_list_status,interest_list_status,message_status,document_status,safe_result,executed_at,audit_id FROM tender.document_access_registrations WHERE tender_id=$1 ORDER BY lot_key",
          [req.params.tenderId],
        )
      ).rows;
      return {
        items: rows.map((row) => {
          const access = registrations.filter(
              (item) => String(item.portal_id) === String(row.portal_id),
            ),
            queue = queueForPortal(row.portal_id),
            costClasses = [
              ...new Set(
                access
                  .map((item) => item.safe_result?.costClass)
                  .filter(Boolean),
              ),
            ],
            evidence = [
              ...new Set(
                access.flatMap(
                  (item) => item.safe_result?.evidenceSource || [],
                ),
              ),
            ];
          const downloaded = Number(queue.documents_downloaded || 0),
            found = Number(queue.documents_found || 0),
            analyzed = Number(queue.documents_analyzed || 0),
            scopedLastError =
              queue.safe_error_code ||
              queue.error_code ||
              null,
            documentTruth = deriveDocumentWorkflowTruth({
              documentsFound: found,
              documentsDownloaded: downloaded,
              documentsAnalyzed: analyzed,
              processingStatus: queue.status,
              processingStep: queue.current_step,
              accessStatus: row.access_status,
              resolutionStatus: queue.document_resolution_status,
              blocker: queue.blocking_reason,
              error: scopedLastError || queue.error_detail_safe,
              nextRetry: queue.next_attempt_at,
            }),
            accessStatus = documentTruth.accessStatus,
            portalOpenUrl = safeExternalPortalUrl(
              row.public_document_access
                ? row.portal_open_candidate
                : row.bidder_area_url,
              row,
            ),
            loginAction = portalLoginAction({
              tenderId: req.params.tenderId,
              companyId: requestedCompany,
              portalId: row.portal_id,
              lotKey: String(req.query?.lot || ""),
              accessStatus,
              configured: row.configured,
              sessionStatus: row.session_status,
              sessionEffectiveStatus: row.session_effective_status,
              lastError: scopedLastError,
              lastSuccessfulLogin: null,
              publicDocumentAccess: row.public_document_access,
              documentsComplete: documentTruth.complete,
              portalOpenAvailable: Boolean(portalOpenUrl),
              authenticationTargetConfigured: Boolean(
                safeExternalPortalUrl(row.authentication_entry_url, row) &&
                  safeExternalPortalUrl(row.bidder_area_url, row),
              ),
            });
          return {
            ...row,
            access_status: accessStatus,
            login_action: loginAction,
            login_action_type: loginAction.type,
            login_action_label: loginAction.label,
            login_action_reason: loginAction.reason,
            portal_open_url: portalOpenUrl,
            document_refresh_action: {
              type: "REFRESH_DOCUMENTS",
              label: "Dokumente aktualisieren",
              binding: loginAction.binding,
            },
            global_document_request_approval: Boolean(policy),
            global_policy_version: policy?.policy_version || null,
            global_policy_audit_id: policy?.audit_id || null,
            global_policy_label: policy
              ? "Dokumentenanforderung durch globale Vorstandsfreigabe zulässig"
              : null,
            cost_check_status:
              access.length && costClasses.length
                ? "ABGESCHLOSSEN"
                : "AUSSTEHEND",
            cost_class: costClasses.join(", ") || null,
            proven_amount: access[0]?.cost_amount ?? null,
            cost_currency: access[0]?.cost_currency || null,
            evidence_source: evidence,
            document_request_executed: access.some((item) =>
              ["DOCUMENT_REQUEST_EXECUTED", "DOCUMENTS_AVAILABLE"].includes(
                item.status,
              ),
            ),
            bidder_list_status:
              access
                .map((item) => item.bidder_list_status)
                .filter(Boolean)
                .join(", ") || null,
            interest_list_status:
              access
                .map((item) => item.interest_list_status)
                .filter(Boolean)
                .join(", ") || null,
            message_status:
              access
                .map((item) => item.message_status)
                .filter(Boolean)
                .join(", ") || null,
            document_request_status:
              access
                .map((item) => `${item.lot_key}:${item.status}`)
                .join(", ") || null,
            document_access_audit_ids: access.map((item) => item.audit_id),
            notice_source: tender.source_code,
            notice_url: tender.source_url,
            next_retry: documentTruth.nextRetry && documentTruth.nextRetry>new Date() ? documentTruth.nextRetry : null,
            automatic_processing: loginAction.type === "NONE" && documentTruth.automaticProcessing,
            current_processing_step: queue.current_step || null,
            processing_started_at: queue.started_at || null,
            processing_finished_at: queue.finished_at || null,
            processing_status: documentTruth.processingStatus,
            processing_blocker: documentTruth.blocker,
            documents_found: found,
            documents_downloaded: downloaded,
            documents_analyzed: analyzed,
            documents_required: documentTruth.required,
            documents_complete: documentTruth.complete,
            retry_required: documentTruth.retryRequired,
            document_resolution_status: documentTruth.resolutionStatus,
            missing_calculation_inputs: queue.missing_calculation_inputs || [],
            last_error:
              documentTruth.error ||
              access.find((item) => item.safe_result?.portalError)?.safe_result
                ?.portalError ||
              null,
            login_required_reason:
              documentTruth.complete
                ? "Alle erforderlichen Vergabeunterlagen sind vollständig geladen und analysiert. Kein erneuter Dokumentabruf erforderlich."
                :
              row.request_effect === "BIDDER_LIST_REGISTRATION_POSSIBLE" &&
              policy
                ? "Die kostenfreie Dokumentenanforderung einschließlich Bieter-/Interessentenliste und Verfahrensnachrichten ist durch die globale Vorstandspolicy freigegeben. Angebotsabgabe und kostenpflichtige Aktionen bleiben gesperrt."
                : row.request_effect === "BIDDER_LIST_REGISTRATION_POSSIBLE"
                  ? "Für die Dokumentenanforderung ist eine Freigabe erforderlich."
                  : row.partner_system
                    ? `Die Vergabe24-Mitgliedschaft ist aktiv. Für die Vergabeunterlagen ist eine reguläre Anmeldung im Partnersystem ${row.partner_system} erforderlich.`
                    : {
                        CREDENTIALS_NOT_CONFIGURED:
                          "Für dieses Portal existiert derzeit kein registrierter Bieteraccount der WB-Gruppe.",
                        MFA_REQUIRED:
                          "Die reguläre Anmeldung wartet auf die MFA-Bestätigung.",
                        LOGIN_FAILED:
                          "Die letzte reguläre Portalanmeldung ist fehlgeschlagen.",
                        SESSION_EXPIRED:
                          "Die reguläre Portalsitzung ist abgelaufen.",
                        SESSION_MISSING:
                          "Es besteht noch keine reguläre Portalsitzung.",
                        LOGIN_REQUIRED:
                          "Für die Angebotsabgabe ist eine reguläre Anmeldung erforderlich.",
                        PORTAL_UNREACHABLE:
                          "Das Zielportal ist nach DNS-/TLS-/HTTP-Prüfung technisch nicht erreichbar.",
                        DOWNLOAD_LINK_UNRESOLVED:
                          "Die Anmeldung ist gültig; der stabile Dokumentdownloadlink muss erneut aufgelöst werden.",
                        EXTERNAL_DOCUMENT_REQUEST_REQUIRED:
                          "Das Portal verlangt eine dokumentbezogene Freischaltung.",
                        DOCUMENT_NOT_FOUND:
                          "Im zugeordneten Workflowbereich ist aktuell keine veröffentlichte Dokumentliste vorhanden.",
                        ACCESS_DENIED:
                          "Das Portal verweigert dem angemeldeten Konto den Zugriff.",
                      }[accessStatus] ||
                      "Portalbereitschaft wird geprüft.",
          };
        }),
      };
    },
  );
  app.get(
    "/api/portal-access/:portalId/tenders",
    { preHandler: read },
    async (req, reply) => {
      const portal = await portalRow(req.params.portalId);
      if (!portal) return reply.code(404).send({ error: "portal_not_found" });
      const rows = (
        await pool.query(
            `SELECT DISTINCT t.id,t.title,t.source_code,t.offer_deadline,t.assigned_user_id,t.sector_id,t.company_id,d.fetch_status FROM tender.enrichment_documents d JOIN tender.enrichment_versions e ON e.id=d.enrichment_version_id JOIN tender.tenders t ON t.id=e.tender_id WHERE lower(split_part(split_part(d.source_url,'://',2),'/',1))=$1 ORDER BY t.offer_deadline NULLS LAST,t.title`,
            [portal.canonical_domain],
        )
      ).rows;
      return {
        items: rows.filter((row) => mayView(req.identity, row)).map((row) => ({
          id: row.id,
          title: row.title,
          source_code: row.source_code,
          offer_deadline: row.offer_deadline,
          fetch_status: row.fetch_status,
        })),
      };
    },
  );
  app.get(
    "/api/portal-access/:portalId/credentials",
    {
      preHandler: requirePermission(["tender.portal.manage", "tender.admin"]),
    },
    async (req, reply) => {
      const portal = await portalRow(req.params.portalId);
      if (!portal) return reply.code(404).send({ error: "portal_not_found" });
      const companyId = String(req.query?.company || ""),
        company = (await accessibleCompanies(req.identity)).find(
          (row) => String(row.company_id) === companyId,
        );
      if (!company)
        return reply.code(403).send({ error: "company_scope_forbidden" });
      const credential = await activeCredentialForCompany(portal.id, companyId);
      return {
        portalId: portal.id,
        portalName: portal.display_name,
        domain: portal.canonical_domain,
        companyId: company.company_id,
        companyName: company.legal_name,
        credential: publicCredential(credential, { manage: true }),
        configured: Boolean(credential),
        credentialId: credential?.id || null,
        credentialVersion: credential?.version || null,
        readOnly: credential ? !credential.submission_capable : true,
        accountConfirmed: Boolean(credential?.account_confirmed),
      };
    },
  );
  app.post(
    "/api/portal-access/:portalId/credentials",
    {
      preHandler: [
        requirePermission(["tender.portal.manage", "tender.admin"]),
        csrf,
      ],
    },
    async (req, reply) => {
      const portal = await portalRow(req.params.portalId);
      if (!portal) return reply.code(404).send({ error: "portal_not_found" });
      const body = req.body || {},
        username = String(body.username || "").trim(),
        password = String(body.password || "");
      if (!username || !password)
        return reply
          .code(400)
          .send({
            error: "portal_credentials_required",
            message: "Benutzername und Passwort sind erforderlich.",
          });
      const submissionCapable = body.submissionCapable === true,
        readOnly = !submissionCapable;
      if (submissionCapable && body.accountConfirmed !== true)
        return reply
          .code(400)
          .send({
            error: "bidder_account_confirmation_required",
            message: "Ein Bieterkonto muss ausdrücklich bestätigt werden.",
          });
      const companyId = String(body.companyId || "");
      if (!validUuid(companyId) || body.companyIds !== undefined)
        return reply
          .code(400)
          .send({
            error: "portal_company_required",
            message: "Genau eine Gesellschaft ist erforderlich.",
          });
      const allowed = (
        await pool.query(
          "SELECT company_id FROM tender.enterprise_company_links WHERE active=true AND company_id=$1::uuid",
          [companyId],
        )
      ).rows;
      const globalAdmin=req.identity.permissions.includes("tender.admin"),identityCompanies=new Set((req.identity.companyIds||[]).map(String));
      if (allowed.length !== 1 || (!globalAdmin&&!identityCompanies.has(companyId)))
        return reply.code(403).send({
          error: "company_scope_forbidden",
          message: "Die ausgewählte Gesellschaft gehört nicht zu Ihrem autorisierten Gesellschaftsbereich.",
        });
      const portalUrl = canonicalPortalUrl(
          new URL(
            portal.login_path || "/",
            `https://${portal.canonical_domain}`,
          ).href,
          portal.canonical_domain,
          portal.allowed_subdomains,
        ),
        encrypted = encryptSecret({
          username,
          password,
          tenant: body.tenant || null,
          customerNumber: body.customerNumber || null,
          organizationId: body.organizationId || null,
          bidderId: body.bidderId || null,
          portalUrl: portalUrl.href,
        }),
        client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM tender.portal_registry WHERE id=$1 FOR UPDATE",[portal.id]);
        const prior = (
          await client.query(
            `SELECT credential.id,credential.version FROM tender.portal_credential_secrets credential
             WHERE credential.portal_id=$1 AND credential.status='ACTIVE' AND EXISTS(
               SELECT 1 FROM tender.portal_credential_companies scope
               WHERE scope.credential_id=credential.id AND scope.company_id=$2::uuid AND scope.active=true
             ) FOR UPDATE`,
            [portal.id,companyId],
          )
        ).rows;
        await client.query(
          `UPDATE tender.portal_read_sessions session SET status='REVOKED',revoked_at=coalesce(revoked_at,now()),verification_status='REVOKED_FOR_LATEST_CREDENTIAL'
           WHERE session.portal_id=$1 AND session.company_id=$2::uuid AND session.status<>'REVOKED'`,
          [portal.id,companyId],
        );
        await client.query(
          `UPDATE tender.portal_login_continuations continuation SET status='SESSION_EXPIRED'
           WHERE continuation.portal_id=$1 AND continuation.company_id=$2::uuid
             AND continuation.status IN('LOGIN_STARTED','WAITING_FOR_USER','MFA_REQUIRED')`,
          [portal.id,companyId],
        );
        const saved = (
          await client.query(
            `INSERT INTO tender.portal_credential_secrets(portal_id,version,ciphertext,iv,auth_tag,key_version,username_masked,internal_label,read_only,mfa_method,valid_until,created_by,account_confirmed,submission_capable,contact_person,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id,version,created_at`,
            [
              portal.id,
              Number((await client.query("SELECT coalesce(max(version),0)+1 version FROM tender.portal_credential_secrets WHERE portal_id=$1",[portal.id])).rows[0].version),
              encrypted.ciphertext,
              encrypted.iv,
              encrypted.authTag,
              encrypted.keyVersion,
              maskUsername(username),
              String(body.internalLabel || "").slice(0, 120) || null,
              readOnly,
              String(body.mfaMethod || "").slice(0, 50) || null,
              body.validUntil || null,
              req.identity.userId,
              body.accountConfirmed === true,
              submissionCapable,
              String(body.contactPerson || "").slice(0, 160) || null,
              String(body.notes || "").slice(0, 1000) || null,
            ],
          )
        ).rows[0];
        await client.query(
          `UPDATE tender.portal_credential_companies scope SET active=false,replaced_at=now(),replaced_by=$3
           FROM tender.portal_credential_secrets credential
           WHERE credential.id=scope.credential_id AND credential.portal_id=$1
             AND scope.company_id=$2::uuid AND scope.active=true`,
          [portal.id,companyId,saved.id],
        );
        await client.query(
          `UPDATE tender.portal_credential_secrets credential SET status='REPLACED',revoked_at=coalesce(revoked_at,now())
           WHERE credential.portal_id=$1 AND credential.id<>$2 AND credential.status='ACTIVE'
             AND NOT EXISTS(SELECT 1 FROM tender.portal_credential_companies scope WHERE scope.credential_id=credential.id AND scope.active=true)`,
          [portal.id,saved.id],
        );
        await client.query(
          "INSERT INTO tender.portal_credential_companies(credential_id,company_id) VALUES($1,$2)",
          [saved.id, companyId],
        );
        await client.query(
          "INSERT INTO tender.portal_connection_events(portal_id,actor_id,action,result_code,safe_detail) VALUES($1,$2,$3,'GESPEICHERT',$4::jsonb)",
          [
            portal.id,
            req.identity.userId,
            prior.length ? "CREDENTIAL_REPLACED" : "CREDENTIAL_CREATED",
            JSON.stringify({
              version: saved.version,
              companyId,
              readOnly,
              submissionCapable,
              accountConfirmed: body.accountConfirmed === true,
            }),
          ],
        );
        await client.query(
          "INSERT INTO tender.audit_events(actor_id,action,metadata) VALUES($1,'portal_credential_saved',$2::jsonb)",
          [
            req.identity.userId,
            JSON.stringify({
              portalId: portal.id,
              version: saved.version,
              companyId,
              readOnly,
              submissionCapable,
              accountConfirmed: body.accountConfirmed === true,
            }),
          ],
        );
        await client.query("COMMIT");
        return reply
          .code(prior.length ? 200 : 201)
          .send({
            saved: true,
            replaced: prior.length>0,
            version: saved.version,
            usernameMasked: maskUsername(username),
            companyId,
            readOnly,
            submissionCapable,
          });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );
  app.delete(
    "/api/portal-access/:portalId/credentials",
    {
      preHandler: [
        requirePermission(["tender.portal.manage", "tender.admin"]),
        csrf,
      ],
    },
    async (req, reply) => {
      const companyId = String(req.query?.company || ""),
        company = (await accessibleCompanies(req.identity)).find(
          (row) => String(row.company_id) === companyId,
        );
      if (!company)
        return reply.code(403).send({ error: "company_scope_forbidden" });
      const credential = await activeCredentialForCompany(
        req.params.portalId,
        companyId,
      );
      if (!credential)
        return reply.code(404).send({ error: "portal_credential_not_found" });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "UPDATE tender.portal_credential_companies SET active=false,replaced_at=coalesce(replaced_at,now()) WHERE credential_id=$1 AND company_id=$2 AND active=true",
          [credential.id,companyId],
        );
        await client.query(
          "UPDATE tender.portal_read_sessions SET status='REVOKED',revoked_at=now() WHERE credential_id=$1 AND company_id=$2 AND status<>'REVOKED'",
          [credential.id,companyId],
        );
        await client.query(
          `UPDATE tender.portal_login_continuations SET status='SESSION_EXPIRED'
           WHERE credential_id=$1 AND company_id=$2
             AND status IN('LOGIN_STARTED','WAITING_FOR_USER','MFA_REQUIRED')`,
          [credential.id,companyId],
        );
        await client.query(
          `UPDATE tender.portal_credential_secrets SET status='REVOKED',revoked_at=now()
           WHERE id=$1 AND NOT EXISTS(
             SELECT 1 FROM tender.portal_credential_companies
             WHERE credential_id=$1 AND active=true
           )`,
          [credential.id],
        );
        await client.query(
          "INSERT INTO tender.portal_connection_events(portal_id,actor_id,action,result_code,safe_detail) VALUES($1,$2,'CREDENTIAL_REMOVED','ENTFERNT',$3::jsonb)",
          [
            req.params.portalId,
            req.identity.userId,
            JSON.stringify({ version: credential.version, companyId }),
          ],
        );
        await client.query(
          "INSERT INTO tender.audit_events(actor_id,action,metadata) VALUES($1,'portal_credential_removed',$2::jsonb)",
          [
            req.identity.userId,
            JSON.stringify({
              portalId: req.params.portalId,
              version: credential.version,
              companyId,
            }),
          ],
        );
        await client.query("COMMIT");
        return { removed: true, companyId };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );
  const runPortalTest = async (req, reply, documentTest = false) => {
    const companyId=String(req.body?.companyId||req.body?.company_id||""),
      companies=await accessibleCompanies(req.identity),
      company=companies.find(row=>String(row.company_id)===companyId),
      portal = await portalRow(req.params.portalId),
      record = portal && company && (await activeCredentialForCompany(portal.id,companyId));
    if(!company)return reply.code(403).send({error:"company_scope_forbidden"});
    if (!portal) return reply.code(404).send({ error: "portal_not_found" });
    if (!record)
      return reply
        .code(409)
        .send({
          error: "portal_credential_not_configured",
          message: "Für dieses Portal ist kein Zugang konfiguriert.",
        });
    const credential = decryptSecret(record),
      result = await testReadOnlyPortal({
        portal,
        credential,
        documentTest,
        oneTimeCode: req.body?.oneTimeCode || null,
      }),
      code = result.resultCode,
      flags = {
        mfa_required: code === "MFA_BESTÄTIGUNG_ERFORDERLICH",
        captcha_required: code === "CAPTCHA_MANUELL_ERFORDERLICH",
        password_expired: code === "PASSWORT_ABGELAUFEN",
        account_locked: code === "KONTO_GESPERRT",
      };
    await pool.query(
      "UPDATE tender.portal_registry SET last_successful_login_at=CASE WHEN $2='LOGIN_ERFOLGREICH' THEN now() ELSE last_successful_login_at END,last_successful_document_fetch_at=CASE WHEN $2='LOGIN_ERFOLGREICH' AND $3 THEN now() ELSE last_successful_document_fetch_at END,last_error_code=CASE WHEN $2='LOGIN_ERFOLGREICH' THEN NULL ELSE $2 END,mfa_required=$4,captcha_required=$5,password_expired=$6,account_locked=$7,updated_at=now() WHERE id=$1",
      [
        portal.id,
        code,
        documentTest,
        flags.mfa_required,
        flags.captcha_required,
        flags.password_expired,
        flags.account_locked,
      ],
    );
    // A generic connection test has no exact tender read-page target. It may
    // prove credentials in its creating browser, but must neither replace a
    // verified reusable session nor be projected as session-valid.
    await safePortalEvent(
      portal.id,
      req.identity.userId,
      req.body?.oneTimeCode
        ? "MFA_CONFIRMATION"
        : documentTest
          ? "DOCUMENT_TEST"
          : "CONNECTION_TEST",
      code,
      { readOnly: true, documentAccess: Boolean(result.documentAccess) },
    );
    await pool.query(
      "INSERT INTO tender.audit_events(actor_id,action,metadata) VALUES($1,'portal_connection_tested',$2::jsonb)",
      [
        req.identity.userId,
        JSON.stringify({
          portalId: portal.id,
          resultCode: code,
          readOnly: true,
          documentTest,
        }),
      ],
    );
    if (documentTest && code === "LOGIN_ERFOLGREICH")
      await pool.query(
        `INSERT INTO tender.autopilot_queue(tender_id,tender_version_id,reason) SELECT DISTINCT e.tender_id,v.id,$2 FROM tender.enrichment_documents d JOIN tender.enrichment_versions e ON e.id=d.enrichment_version_id JOIN LATERAL(SELECT id FROM tender.tender_versions WHERE tender_id=e.tender_id ORDER BY version DESC LIMIT 1)v ON true WHERE lower(split_part(split_part(d.source_url,'://',2),'/',1))=$1 ON CONFLICT DO NOTHING`,
        [
          portal.canonical_domain,
          `PORTAL_READ_REFRESH_${portal.id}_${Date.now()}`,
        ],
      );
    return {
      resultCode: code,
      readOnly: true,
      mfaRequired: flags.mfa_required,
      captchaRequired: flags.captcha_required,
      sessionValidUntil: null,
      sessionRestoreRequired: Boolean(result.session),
      documentAccess: Boolean(result.documentAccess),
      companyId,
      transmitted: false,
    };
  };
  app.post(
    "/api/portal-access/:portalId/test",
    {
      preHandler: [
        requirePermission(["tender.portal.manage", "tender.admin"]),
        csrf,
      ],
    },
    (req, reply) => runPortalTest(req, reply, false),
  );
  app.post(
    "/api/portal-access/:portalId/test-documents",
    {
      preHandler: [
        requirePermission(["tender.portal.manage", "tender.admin"]),
        csrf,
      ],
    },
    (req, reply) => runPortalTest(req, reply, true),
  );
  list(
    "/api/approvals",
    "tender.view_assigned",
    "SELECT id,tender_id,action_type,payload_sha256,status,expires_at,created_at FROM tender.approval_requests ORDER BY created_at DESC LIMIT 100",
  );
  list(
    "/api/audit",
    "tender.audit.view",
    "SELECT id,actor_id,action,tender_id,metadata,occurred_at FROM tender.audit_events ORDER BY id DESC LIMIT 200",
  );
  app.get(
    "/api/scheduler/status",
    { preHandler: requirePermission("tender.scheduler.view") },
    async () => ({
      sources: (
        await pool.query(`SELECT w.*,l.owner_id,l.expires_at FROM tender.scheduler_worker_status w
      LEFT JOIN tender.scheduler_leases l USING(source_code) ORDER BY source_code`)
      ).rows,
      runs: (
        await pool.query(
          "SELECT * FROM tender.scheduler_runs ORDER BY started_at DESC LIMIT 50",
        )
      ).rows,
      externalWritesEnabled: false,
    }),
  );
  app.get(
    "/api/import-quarantine",
    { preHandler: requirePermission("tender.scheduler.view") },
    async (req) => {
      const q = req.query || {};
      const params = [
        String(q.source || "").toUpperCase(),
        String(q.status || ""),
        Math.min(
          Math.max(Number.parseInt(String(q.limit || "100"), 10) || 100, 1),
          200,
        ),
      ];
      const rows = (
        await pool.query(
          `SELECT q.id,q.source_code,q.external_id,q.import_run_id,
      q.payload_sha256,q.error_code,q.error_class,q.error_field,q.safe_message,
      q.retry_status,q.retry_count,q.next_retry_at,q.manual_review_status,
      q.parser_version,q.mapper_version,q.created_at,q.updated_at
      FROM tender.import_quarantine q
      WHERE ($1='' OR q.source_code=$1) AND ($2='' OR q.retry_status=$2)
      ORDER BY q.created_at DESC LIMIT $3`,
          params,
        )
      ).rows;
      return {
        items: rows,
        total: rows.length,
        rawPayloadIncluded: false,
        externalActionsEnabled: false,
      };
    },
  );
  app.post(
    "/api/scheduler/run/:source",
    { preHandler: [requirePermission("tender.scheduler.run"), csrf] },
    async (req, reply) => {
      const source = String(req.params.source || "").toUpperCase();
      if (!["TED", "DOE"].includes(source))
        return reply.code(400).send({ error: "source_invalid" });
      const config = (
        await pool.query(
          "SELECT enabled,kill_switch FROM tender.scheduler_sources WHERE source_code=$1",
          [source],
        )
      ).rows[0];
      if (!config || !config.enabled || config.kill_switch)
        return reply
          .code(423)
          .send({ error: "scheduler_manual_release_required", queued: false });
      const row = (
        await pool.query(
          `INSERT INTO tender.scheduler_commands(source_code,requested_by)
      VALUES($1,$2) RETURNING id,status,requested_at`,
          [source, req.identity.userId],
        )
      ).rows[0];
      await pool.query(
        "INSERT INTO tender.audit_events(actor_id,action,metadata) VALUES($1,'rc32_manual_run_requested',$2)",
        [
          req.identity.userId,
          { source, commandId: row.id, externalWrite: false },
        ],
      );
      return reply.code(202).send(row);
    },
  );
  app.get(
    "/api/operations/revenue-dashboard",
    { preHandler: requirePermission("tender.inbox.view") },
    async (req, reply) => {
      reply.header("cache-control", "no-store").header("vary", "Cookie");
      const companies = await accessibleCompanies(req.identity);
      if (!companies.length) return {top10:[],kpis:buildOperationsKpis([]),learning:learnFromRealOutcomes([]),evidencePolicy:"REAL_DATA_ONLY"};
      const requested = String(req.query?.company || "all"), selected = requested === "all" ? null : companies.find(item => String(item.company_id) === requested);
      if (requested !== "all" && !selected) return reply.code(403).send({error:"company_scope_forbidden",message:"Die ausgewählte Gesellschaft ist nicht zulässig."});
      const rows = (await pool.query(`
        SELECT t.id tender_id,t.title,t.buyer,t.offer_deadline,r.company_id,r.lot_key,r.relevance_status,r.service_scope_gate,
          coalesce(e.classification,'REGION_UNRESOLVED') region_classification,
          calc.status calculation_status,calc.totals calculation_totals,
          mo.status management_status,pre.readiness_status,pre.binding_valid,
          coalesce(rd.missing_documents,0)::int missing_documents,
          coalesce(rd.validated_documents,0)::int validated_documents,
          coalesce(rd.rejected_documents,0)::int rejected_documents,
          coalesce(rd.validated_certificates,0)::int validated_certificates,
          coalesce(rd.rejected_certificates,0)::int rejected_certificates,
          coalesce(rd.validated_references,0)::int validated_references,
          coalesce(rd.rejected_references,0)::int rejected_references,
          coalesce(rd.missing_evidence,'{}'::text[]) missing_evidence,
          coalesce(fr.open_requirements,0)::int open_requirements,
          coalesce(fr.total_requirements,0)::int total_requirements,
          coalesce(fr.requirement_titles,'{}'::text[]) requirement_titles
        FROM tender.current_service_relevance r
        JOIN tender.tenders t ON t.id=r.tender_id AND t.data_class='PUBLIC_REAL'
        LEFT JOIN LATERAL(SELECT classification FROM tender.region_evaluations x WHERE x.tender_id=r.tender_id AND x.company_id=r.company_id ORDER BY evaluation_version DESC LIMIT 1)e ON true
        LEFT JOIN LATERAL(SELECT status,totals FROM tender.calculations x WHERE x.tender_id=r.tender_id AND x.company_id=r.company_id AND x.lot_key=coalesce(r.lot_key,'') ORDER BY version DESC LIMIT 1)calc ON true
        LEFT JOIN LATERAL(SELECT status FROM tender.management_outputs x WHERE x.tender_id=r.tender_id AND x.company_id=r.company_id AND x.lot_key=coalesce(r.lot_key,'') AND historical=false ORDER BY created_at DESC LIMIT 1)mo ON true
        LEFT JOIN tender.final_preflight_contexts pre ON pre.tender_id=r.tender_id AND pre.company_id=r.company_id AND pre.lot_key=coalesce(r.lot_key,'') AND pre.is_current
        LEFT JOIN LATERAL(SELECT
          count(*) filter(where mandatory and submission_relevant and satisfaction_status not in('VALIDATED','NOT_REQUIRED','SUPERSEDED')) missing_documents,
          count(*) filter(where satisfaction_status='VALIDATED') validated_documents,
          count(*) filter(where satisfaction_status='REJECTED') rejected_documents,
          count(*) filter(where satisfaction_status='VALIDATED' and category ilike '%CERT%') validated_certificates,
          count(*) filter(where satisfaction_status='REJECTED' and category ilike '%CERT%') rejected_certificates,
          count(*) filter(where satisfaction_status='VALIDATED' and category ilike '%REFER%') validated_references,
          count(*) filter(where satisfaction_status='REJECTED' and category ilike '%REFER%') rejected_references,
          array_agg(requirement_title order by requirement_title) filter(where mandatory and satisfaction_status not in('VALIDATED','NOT_REQUIRED','SUPERSEDED')) missing_evidence
          FROM tender.required_documents x WHERE x.tender_id=r.tender_id AND x.company_id=r.company_id AND x.lot_key=coalesce(r.lot_key,''))rd ON true
        LEFT JOIN LATERAL(SELECT count(*) total_requirements,count(*) filter(where status not in('VALIDATED','NOT_REQUIRED','SUPERSEDED')) open_requirements,array_agg(title order by title) requirement_titles FROM tender.final_preflight_requirements x WHERE x.context_id=pre.id)fr ON true
        WHERE r.company_id=ANY($1::uuid[]) AND ($2::uuid IS NULL OR r.company_id=$2) AND (t.offer_deadline IS NULL OR t.offer_deadline>now())
          AND r.primary_company=true
        ORDER BY t.offer_deadline NULLS LAST LIMIT 5000`,[companies.map(item=>item.company_id),selected?.company_id||null])).rows;
      const candidates = rows.map(row => {
        const totals = row.calculation_totals || {}, calculationComplete = row.calculation_status === "CALCULATION_COMPLETED" || row.calculation_status === "CALCULATED";
        const requirementsComplete = row.total_requirements > 0 ? row.open_requirements === 0 : null;
        return {
          tenderId:row.tender_id,lotKey:row.lot_key,companyId:row.company_id,title:row.title,buyer:row.buyer,offerDeadline:row.offer_deadline,
          groupFit:row.service_scope_gate === "PASSED",companyFit:row.relevance_status === "RELEVANT",
          certificates:row.rejected_certificates ? false : row.validated_certificates ? true : null,
          references:row.rejected_references ? false : row.validated_references ? true : null,
          region:["CORE_REGION","STRATEGIC_REGION"].includes(row.region_classification) ? true : row.region_classification === "EXCLUDED_REGION" ? false : null,
          capacity:totals.capacityValidated === true ? true : totals.capacityValidated === false ? false : null,
          economics:calculationComplete && [totals.contractValue,totals.totalPrice,totals.offerPriceNet].some(value=>value!==null&&value!==undefined) ? true : null,
          deadline:row.offer_deadline ? new Date(row.offer_deadline)>new Date() : null,
          calculation:calculationComplete,submission:row.readiness_status === "PREFLIGHT_READY" && row.binding_valid ? true : null,
          calculationTotals:totals,documentsComplete:row.missing_documents === 0 && row.validated_documents > 0,
          requirementsComplete,calculationComplete,managementComplete:row.management_status === "COMPLETED" || row.management_status === "APPROVED",
          preflightComplete:row.readiness_status === "PREFLIGHT_READY",missingDocuments:row.missing_documents,
          processingEffort:row.total_requirements ? Math.min(100,row.open_requirements/row.total_requirements*100) : null,
          strategicImportance:null,observedAwardProbability:null,risks:Array.isArray(totals.risks)?totals.risks:[],
        };
      });
      const prioritized = prioritizeOperationsCandidates(candidates);
      return {
        title:"Womit verdienen wir als nächstes Geld?",
        generatedAt:new Date().toISOString(),
        evidencePolicy:"REAL_DATA_ONLY",
        top10:prioritized.filter(item=>item.decision!=="NO_GO").slice(0,10),
        kpis:buildOperationsKpis(candidates),
        learning:learnFromRealOutcomes(rows.map(row=>({dataClass:"PUBLIC_REAL",processed:Boolean(row.management_status||row.calculation_status),tenderId:row.tender_id,requirements:row.requirement_titles,missingEvidence:row.missing_evidence,successfulConcepts:[],outcome:null,calculationVersion:null}))),
        unranked:prioritized.filter(item=>item.priority===null).length,
        companies,
        selectedCompany:selected?.company_id||null,
        externalSubmission:false,
      };
    },
  );
  app.get(
    "/api/management-inbox",
    { preHandler: requirePermission("tender.inbox.view") },
    async (req, reply) => {
      reply.header("cache-control", "no-store").header("vary", "Cookie");
      const companies = await accessibleCompanies(req.identity);
      if (!companies.length)
        return {
          items: [],
          total: 0,
          companies: [],
          selectedCompany: null,
          counts: {},
        };
      const requested = String(req.query?.company || "all"),
        all = requested.toLowerCase() === "all",
        selected = all
          ? null
          : companies.find((x) => String(x.company_id) === requested);
      if (!all && !selected)
        return reply
          .code(403)
          .send({
            error: "company_scope_forbidden",
            message: "Die ausgewählte Gesellschaft ist nicht zulässig.",
          });
      const relevanceFilter = String(req.query?.relevance || "relevant"),
        statuses =
          relevanceFilter === "all"
            ? null
            : relevanceFilter === "excluded"
              ? ["NOT_RELEVANT", "EXCLUDED", "NOT_APPLICABLE"]
              : relevanceFilter === "review"
                ? ["POTENTIALLY_RELEVANT", "MANUAL_CLASSIFICATION_REQUIRED"]
                : ["RELEVANT", "POTENTIALLY_RELEVANT"],
        serviceLine = String(req.query?.serviceLine || "");
      const regionFilter = String(req.query?.regionClass || "all"),
        allowedClasses =
          regionFilter === "all"
            ? null
            : regionFilter === "default"
              ? ["CORE_REGION", "STRATEGIC_REGION"]
              : regionFilter
                  .split(",")
                  .filter((x) =>
                    [
                      "CORE_REGION",
                      "STRATEGIC_REGION",
                      "OUTSIDE_CORE_REGION",
                      "EXCLUDED_REGION",
                      "REGION_UNRESOLVED",
                      "REGION_CONFIG_CONFLICT",
                      "MULTI_REGION_REVIEW",
                      "NOT_APPLICABLE",
                    ].includes(x),
                  );
      const ids = companies.map((x) => x.company_id),
        rows = (
          await pool.query(
            `WITH relevance AS(SELECT r.*,registered.portal_id,registered.credential_id,row_number() OVER(PARTITION BY r.tender_id,r.lot_key ORDER BY r.primary_company DESC,r.relevance_status,r.company_id) canonical_rank,bool_or(r.primary_company) OVER(PARTITION BY r.tender_id,r.lot_key) has_primary FROM tender.current_service_relevance r JOIN tender.current_registered_tender_company_portals registered ON registered.tender_id=r.tender_id AND registered.company_id=r.company_id WHERE r.company_id=ANY($1::uuid[])), latest_region AS(SELECT DISTINCT ON(e.tender_id,e.company_id,e.lot_id) e.* FROM tender.region_evaluations e WHERE e.company_id=ANY($1::uuid[]) ORDER BY e.tender_id,e.company_id,e.lot_id,e.evaluation_version DESC) SELECT e.*,t.title,t.buyer,t.regions,t.offer_deadline,t.source_url,t.source_code,t.cpv_codes,l.legal_name company_name,r.portal_id,r.credential_id,r.service_line,r.relevance_status,r.service_scope_gate,r.reason relevance_reason,r.recommendation relevance_recommendation,r.lot_key,r.evaluation_version relevance_version,i.id inbox_id,i.workflow_status,i.rule_score,i.decision historical_decision,cs.id canonical_snapshot_id,cs.profile_snapshot_id,cs.payload->'calculationInput'->>'status' canonical_calculation_status,q.status pipeline_status,q.calculation_status pipeline_calculation_status,q.current_step,q.last_successful_step,q.finished_at,q.heartbeat_at,q.next_step,q.next_attempt_at,q.missing_calculation_inputs,calc.status calculation_result_status,calc.blocked_reasons,calc.totals calculation_totals,mo.status management_status,mo.created_at management_output_at,mo.payload->'recommendation' management_recommendation,ar.id approval_request_id,ar.status approval_status,ar.expires_at approval_expires_at FROM relevance r JOIN tender.tenders t ON t.id=r.tender_id JOIN tender.enterprise_company_links l ON l.company_id=r.company_id LEFT JOIN latest_region e ON e.tender_id=r.tender_id AND e.company_id=r.company_id AND e.lot_id IS NULL LEFT JOIN LATERAL(SELECT x.* FROM tender.management_inbox x WHERE x.tender_id=r.tender_id AND (x.company_id=r.company_id OR x.company_id IS NULL) ORDER BY (x.company_id=r.company_id) DESC,x.created_at DESC LIMIT 1)i ON true LEFT JOIN LATERAL(SELECT x.* FROM tender.canonical_read_snapshots x WHERE x.tender_id=r.tender_id AND x.company_id=r.company_id AND x.lot_key=coalesce(r.lot_key,'') AND x.status='CURRENT' ORDER BY x.created_at DESC LIMIT 1)cs ON true LEFT JOIN LATERAL(SELECT x.* FROM tender.autopilot_queue x WHERE x.tender_id=r.tender_id AND x.company_id=r.company_id AND x.lot_key=coalesce(r.lot_key,'') ORDER BY x.created_at DESC LIMIT 1)q ON true LEFT JOIN LATERAL(SELECT x.* FROM tender.calculations x WHERE x.tender_id=r.tender_id AND x.company_id=r.company_id AND x.lot_key=coalesce(r.lot_key,'') ORDER BY x.version DESC LIMIT 1)calc ON true LEFT JOIN LATERAL(SELECT x.* FROM tender.management_outputs x WHERE x.tender_id=r.tender_id AND x.company_id=r.company_id AND x.lot_key=coalesce(r.lot_key,'') AND x.historical=false ORDER BY x.created_at DESC LIMIT 1)mo ON true LEFT JOIN LATERAL(SELECT x.* FROM tender.approval_requests x WHERE x.tender_id=r.tender_id AND x.calculation_id=calc.id AND x.action_type='BID_SUBMISSION' ORDER BY x.created_at DESC LIMIT 1)ar ON true WHERE (($8::boolean AND ar.status='REQUESTED') OR ($3::text[] IS NULL OR r.relevance_status=ANY($3))) AND (r.primary_company OR ($7::boolean AND NOT r.has_primary AND r.canonical_rank=1)) AND ($2::uuid IS NULL OR r.company_id=$2) AND ($4='' OR r.service_line=$4) AND ($5::text[] IS NULL OR coalesce(e.classification,'REGION_UNRESOLVED')=ANY($5)) ORDER BY (ar.status='REQUESTED') DESC,t.offer_deadline NULLS LAST,t.created_at DESC,r.tender_id,r.lot_key NULLS LAST LIMIT $6`,
            [
              ids,
              selected?.company_id || null,
              statuses,
              serviceLine,
              allowedClasses,
              5000,
              relevanceFilter === "excluded" || relevanceFilter === "all",
              relevanceFilter === "review",
            ],
          )
        ).rows;
      const fixtureTenderIds = new Set(
        (
          await pool.query(
            "SELECT id FROM tender.tenders WHERE data_class<>'PUBLIC_REAL'",
          )
        ).rows.map((row) => String(row.id)),
      );
      for (let index = rows.length - 1; index >= 0; index -= 1)
        if (fixtureTenderIds.has(String(rows[index].tender_id)))
          rows.splice(index, 1);
      const monitoringRows = (
          await pool.query(
            "SELECT tender_id,lot_key,status,last_checked_at,next_check_at,state FROM tender.procedure_monitoring WHERE tender_id=ANY($1::uuid[])",
            [[...new Set(rows.map((row) => row.tender_id))]],
          )
        ).rows,
        monitoringByContext = new Map(
          monitoringRows.map((row) => [`${row.tender_id}:${row.lot_key}`, row]),
        );
      for (const row of rows) {
        row.regions = unique(row.regions);
        row.cpv_codes = unique(row.cpv_codes);
        row.detected_nuts = unique(row.detected_nuts);
        row.detected_states = unique(row.detected_states);
        row.calculationStatus = canonicalCalculationStatus(row);
        row.managementOutputStatus = row.management_status || "NOT_CREATED";
        row.lastProcessedAt =
          row.management_output_at ||
          row.finished_at ||
          row.heartbeat_at ||
          null;
        row.lastProcessedStep =
          row.last_successful_step || row.current_step || "NO_PIPELINE_ATTEMPT";
        row.nextAction =
          row.next_step ||
          (row.calculationStatus === "CALCULATION_BLOCKED_MISSING_FACILITY_PROFILE"
            ? "FACILITY_KALKULATIONSPROFIL_FREIGEBEN"
            : row.calculationStatus === "CALCULATION_BLOCKED_MISSING_INPUT"
            ? "AUTOMATIC_RETRIGGER_ON_NEW_DOCUMENTS"
            : row.calculationStatus ===
                "CALCULATION_BLOCKED_DOCUMENTS_NOT_AVAILABLE"
              ? "AUTOMATIC_DOCUMENT_RETRY"
              : row.calculationStatus === "NOT_STARTED"
                ? "IMMEDIATE_PROCESSING_QUEUE"
                : "NO_AUTOMATIC_ACTION");
        const missing = Array.isArray(
          row.missing_calculation_inputs || row.blocked_reasons,
        )
          ? row.missing_calculation_inputs || row.blocked_reasons
          : [];
        row.missingCalculationInputs = [
          ...new Map(
            missing.map((value) => [
              typeof value === "object" ? JSON.stringify(value) : String(value),
              value,
            ]),
          ).values(),
        ];
        const monitoring = monitoringByContext.get(
          `${row.tender_id}:${row.lot_key || ""}`,
        );
        row.monitoringStatus = monitoring?.status || "INACTIVE";
        row.monitoringLastCheckedAt = monitoring?.last_checked_at || null;
        row.monitoringNextCheckAt = monitoring?.next_check_at || null;
        row.monitoringLastEvent = monitoring?.state?.lastEventType || null;
        if (row.calculationStatus === "TECHNICAL_STATUS_ERROR")
          req.log.error(
            {
              tenderId: row.tender_id,
              companyId: row.company_id,
              lotKey: row.lot_key,
              managementStatus: row.management_status,
            },
            "unknown calculation status in management inbox",
          );
      }
      const lifecycles = await noticeLifecycles([
        ...new Set(rows.map((row) => row.tender_id)),
      ]);
      for (const row of rows) {
        const lifecycle = lifecycles.get(String(row.tender_id));
        if (lifecycle) {
          row.noticeLifecycle = lifecycle;
          row.calculationStatus = "NOT_APPLICABLE_AWARD_NOTICE";
          row.nextAction = "NO_AUTOMATIC_ACTION";
          row.missingCalculationInputs = [];
        }
      }
      const counts = {};
      for (const row of rows)
        counts[row.classification || "REGION_UNRESOLVED"] =
          (counts[row.classification || "REGION_UNRESOLVED"] || 0) + 1;
      if (!all)
        return {
          items: rows,
          total: rows.length,
          companies,
          selectedCompany: selected.company_id,
          counts,
          defaultClasses: ["CORE_REGION", "STRATEGIC_REGION"],
          filters: { relevance: relevanceFilter, serviceLine },
          semanticStatus: "SERVICE_SCOPE_GATE_ACTIVE",
        };
      const items = rows.map((row) => ({
        ...row,
        companyEvaluations: [
          {
            companyId: row.company_id,
            company: row.company_name,
            classification: row.classification || "REGION_UNRESOLVED",
            label: row.classification || "REGION_UNRESOLVED",
            decision: row.regional_decision || row.relevance_recommendation,
            reason: row.relevance_reason,
          },
        ],
      }));
      return {
        items,
        total: items.length,
        companies,
        selectedCompany: "all",
        counts,
        defaultClasses: ["CORE_REGION", "STRATEGIC_REGION"],
        filters: { relevance: relevanceFilter, serviceLine },
        semanticStatus: "SERVICE_SCOPE_GATE_ACTIVE",
      };
    },
  );
  app.get(
    "/api/management-inbox/region-detail/:tenderId",
    { preHandler: requirePermission("tender.inbox.view") },
    async (req, reply) => {
      const companies = await accessibleCompanies(req.identity),
        requestedLot = String(req.query?.lot || ""),
        company = companies.find(
          (x) => String(x.company_id) === String(req.query?.company || ""),
        );
      if (!company)
        return reply.code(403).send({ error: "company_scope_forbidden" });
      const evaluation = (
        await pool.query(
          `SELECT e.*,t.title,t.buyer,t.regions,t.offer_deadline,t.source_url,t.source_code,t.notice_number,t.external_id,l.legal_name company_name,registered.portal_id,registered.credential_id,r.service_line,r.relevance_status,r.service_scope_gate,r.reason relevance_reason,r.recommendation relevance_recommendation,r.evaluation_version relevance_version,r.lot_key relevance_lot_key FROM tender.region_evaluations e JOIN tender.tenders t ON t.id=e.tender_id JOIN tender.enterprise_company_links l ON l.company_id=e.company_id JOIN tender.current_service_relevance r ON r.tender_id=e.tender_id AND r.company_id=e.company_id AND r.primary_company=true JOIN tender.current_registered_tender_company_portals registered ON registered.tender_id=e.tender_id AND registered.company_id=e.company_id WHERE e.tender_id=$1 AND e.company_id=$2 AND e.lot_id IS NULL AND coalesce(r.lot_key,'')=$3 ORDER BY e.evaluation_version DESC LIMIT 1`,
          [req.params.tenderId, company.company_id, requestedLot],
        )
      ).rows[0];
      if (!evaluation)
        return reply
          .code(404)
          .send({
            error: "relevant_tender_not_found",
            message:
              "Diese Ausschreibung ist für die ausgewählte Gesellschaft nicht fachlich relevant.",
          });
      const lots = (
        await pool.query(
          `SELECT e.*,l.external_id,l.title FROM tender.region_evaluations e JOIN tender.lots l ON l.id=e.lot_id WHERE e.tender_id=$1 AND e.company_id=$2 AND e.lot_id IS NOT NULL AND e.batch_id=$3 ORDER BY l.external_id`,
          [req.params.tenderId, company.company_id, evaluation.batch_id],
        )
      ).rows;
      const latest =
        (
          await pool.query(
            `SELECT ev.explanation FROM tender.evaluations ev WHERE ev.tender_id=$1 AND ev.explanation->>'reviewType' IN ('FULL_TENDER_REVIEW','FULL_TENDER_AUTOPILOT') AND ev.explanation->>'companyId'=$2 AND coalesce(ev.explanation->>'lotKey','')=$3 ORDER BY ev.created_at DESC LIMIT 1`,
            [req.params.tenderId, String(company.company_id),requestedLot],
          )
        ).rows[0]?.explanation?.review || null;
      const autopilot =
        (
          await pool.query(
            "SELECT ar.id,ar.result_version,ar.pipeline_version,ar.enrichment_version_id,ar.stage_status,ar.prepared_tasks,ar.prepared_deadlines,ar.board_brief,ar.created_at FROM tender.autopilot_results ar WHERE ar.tender_id=$1 AND ar.company_id=$2 AND ar.lot_key IS NOT DISTINCT FROM $3 ORDER BY ar.result_version DESC LIMIT 1",
            [
              req.params.tenderId,
              company.company_id,
              evaluation.relevance_lot_key || null,
            ],
          )
        ).rows[0] || null;
      const [tenderVersion, enrichment, lot, queue] = await Promise.all([
        pool.query(
          "SELECT id,version FROM tender.tender_versions WHERE tender_id=$1 ORDER BY version DESC LIMIT 1",
          [req.params.tenderId],
        ),
        pool.query(
          "SELECT id,version FROM tender.enrichment_versions WHERE tender_id=$1 ORDER BY version DESC LIMIT 1",
          [req.params.tenderId],
        ),
        evaluation.relevance_lot_key
          ? pool.query(
              "SELECT id,external_id,title,deadline FROM tender.lots WHERE tender_id=$1 AND external_id=$2 UNION ALL SELECT el.id,el.lot_key external_id,NULL::text title,NULL::timestamptz deadline FROM tender.enrichment_lots el JOIN tender.enrichment_versions ev ON ev.id=el.enrichment_version_id WHERE ev.tender_id=$1 AND el.lot_key=$2 AND NOT EXISTS(SELECT 1 FROM tender.lots WHERE tender_id=$1 AND external_id=$2) ORDER BY id LIMIT 1",
              [req.params.tenderId, evaluation.relevance_lot_key],
            )
          : Promise.resolve({ rows: [] }),
        pool.query(
          "SELECT aq.portal_id FROM tender.autopilot_queue aq WHERE aq.tender_id=$1 AND aq.company_id=$2 AND aq.lot_key IS NOT DISTINCT FROM $3 AND aq.portal_id IS NOT NULL ORDER BY aq.created_at DESC LIMIT 1",
          [
            req.params.tenderId,
            company.company_id,
            evaluation.relevance_lot_key || null,
          ],
        ),
      ]);
      const permissions = req.identity.permissions || [],
        can = (p) =>
          permissions.includes("tender.admin") || permissions.includes(p);
      const actionContext = {
        tender_id: req.params.tenderId,
        tender_version_id: tenderVersion.rows[0]?.id || null,
        notice_id: evaluation.notice_number || evaluation.external_id || null,
        lot_id: lot.rows[0]?.id || null,
        lot_key: evaluation.relevance_lot_key || null,
        company_id: company.company_id,
        service_scope: evaluation.service_line || null,
        portal_id: queue.rows[0]?.portal_id || null,
        enrichment_version_id: enrichment.rows[0]?.id || null,
        assessment_version_id: evaluation.relevance_version || null,
        configuration_version_id: String(
          evaluation.configuration_version_no || "UNVERSIONED",
        ),
      };
      const missingContext = Object.entries(actionContext)
        .filter(
          ([key, value]) =>
            [
              "tender_id",
              "tender_version_id",
              "notice_id",
              "lot_id",
              "company_id",
              "service_scope",
              "enrichment_version_id",
              "assessment_version_id",
              "configuration_version_id",
            ].includes(key) &&
            (value === null || value === ""),
        )
        .map(([key]) => key);
      const favoriteSaved=(await pool.query("SELECT EXISTS(SELECT 1 FROM tender.favorites WHERE user_id=$1 AND tender_id=$2 AND company_id=$3 AND lot_key IS NOT DISTINCT FROM $4::text) saved",[req.identity.userId,req.params.tenderId,company.company_id,evaluation.relevance_lot_key||null])).rows[0].saved;
      const savedInternalActions=(await pool.query(managementInboxSavedActionsSql,[req.identity.userId,req.params.tenderId,String(company.company_id),String(evaluation.relevance_lot_key||"")])).rows;
      return {
        ...evaluation,
        lots,
        fullReview: latest,
        autopilot,
        actionContext,
        missingContext,
        favoriteSaved,
        savedInternalActions,
        deadline: {
          value: lot.rows[0]?.deadline || evaluation.offer_deadline || null,
          type: lot.rows[0]?.deadline ? "Losfrist" : "Angebotsfrist",
          source: lot.rows[0]?.deadline
            ? `Los ${lot.rows[0]?.external_id}`
            : `${evaluation.source_code}-Bekanntmachung`,
        },
        permissions: {
          evaluate: can("tender.evaluate"),
          favorite: can("tender.favorite"),
          task: can("tender.task.manage"),
          deadline: can("tender.deadline.manage"),
          board: can("tender.board.view"),
          calculation: can("tender.view_assigned"),
        },
        rawTenderChanged: false,
        historicalInboxDecisionPreserved: true,
      };
    },
  );

  const validateActionContext = async (req, reply) => {
    const body = req.body || {},
      required = [
        "tender_id",
        "tender_version_id",
        "notice_id",
        "lot_id",
        "company_id",
        "service_scope",
        "enrichment_version_id",
        "assessment_version_id",
        "configuration_version_id",
      ],
      missing = required.filter(
        (key) =>
          body[key] === null || body[key] === undefined || body[key] === "",
      );
    if (missing.length) {
      reply
        .code(409)
        .send({
          error: "FEHLENDER_TENDERKONTEXT",
          missing_fields: missing,
          message: `Erforderlicher Aktionskontext fehlt: ${missing.join(", ")}`,
        });
      return null;
    }
    if (String(body.tender_id) !== String(req.params.tenderId)) {
      reply.code(409).send({ error: "FALSCHER_TENDERKONTEXT" });
      return null;
    }
    const companies = await accessibleCompanies(req.identity);
    if (
      !companies.some((x) => String(x.company_id) === String(body.company_id))
    ) {
      reply.code(403).send({ error: "company_scope_forbidden" });
      return null;
    }
    if (!(await requireRegisteredScope(reply, body.tender_id, body.company_id)))
      return null;
    const valid = (
      await pool.query(
        "SELECT EXISTS(SELECT 1 FROM tender.tender_versions WHERE id=$1 AND tender_id=$2) version_ok,EXISTS(SELECT 1 FROM tender.enrichment_versions WHERE id=$3 AND tender_id=$2) enrichment_ok",
        [body.tender_version_id, body.tender_id, body.enrichment_version_id],
      )
    ).rows[0];
    if (!valid.version_ok || !valid.enrichment_ok) {
      reply
        .code(409)
        .send({
          error: "VERALTETER_TENDERKONTEXT",
          message:
            "Die Detailseite verwendet nicht mehr die aktive Tender- oder Anreicherungsversion.",
        });
      return null;
    }
    return body;
  };
  app.post(
    "/api/management-inbox/actions/:tenderId/favorite",
    { preHandler: [requirePermission("tender.favorite"), csrf] },
    async (req, reply) => {
      const c = await validateActionContext(req, reply);
      if (!c) return;
      const saved=await saveFavorite(pool,{
        userId:req.identity.userId,
        tenderId:c.tender_id,
        companyId:c.company_id,
        lotKey:c.lot_key||null,
      });
      if(!saved.idempotent)await pool.query(
        "INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'favorite',$2,$3)",
        [req.identity.userId, c.tender_id, { ...c, favorite_id:saved.item.id, externalWrite: false, transmitted:false }],
      );
      return { ok: true, idempotent: saved.idempotent, favorite_id:saved.item.id, request_id: crypto.randomUUID(), transmitted:false };
    },
  );
  app.post(
    "/api/management-inbox/actions/:tenderId/task",
    { preHandler: [requirePermission("tender.task.manage"), csrf] },
    async (req, reply) => {
      const c = await validateActionContext(req, reply);
      if (!c) return;
      const title = String(req.body?.title || "")
        .trim()
        .slice(0, 300);
      if (!title)
        return reply
          .code(400)
          .send({
            error: "title_required",
            message: "Ein Aufgabentitel ist erforderlich.",
          });
      const dueAt=req.body?.due_at||null,existing=(await pool.query("SELECT id FROM tender.tasks WHERE tender_id=$1 AND assignee_id=$2 AND title=$3 AND due_at IS NOT DISTINCT FROM $4::timestamptz LIMIT 1",[c.tender_id,req.identity.userId,title,dueAt])).rows[0],row=existing||(await pool.query(
          "INSERT INTO tender.tasks(tender_id,assignee_id,due_at,title) VALUES($1,$2,$3,$4) RETURNING id",
          [c.tender_id, req.identity.userId, dueAt, title],
        )).rows[0];
      await pool.query(
        "INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'task_created',$2,$3)",
        [
          req.identity.userId,
          c.tender_id,
          { ...c, taskId: row.id, externalWrite: false },
        ],
      );
      return reply.code(existing?200:201).send({ ok: true, id: row.id,idempotent:Boolean(existing), request_id: crypto.randomUUID() });
    },
  );
  app.post(
    "/api/management-inbox/actions/:tenderId/deadline",
    { preHandler: [requirePermission("tender.deadline.manage"), csrf] },
    async (req, reply) => {
      const c = await validateActionContext(req, reply);
      if (!c) return;
      const at = req.body?.deadline_at;
      if (!at)
        return reply
          .code(400)
          .send({
            error: "deadline_required",
            message:
              "Für diese Ausschreibung ist keine übernehmbare Frist vorhanden.",
          });
      const existing = (
          await pool.query(
            "SELECT id FROM tender.reminders WHERE tender_id=$1 AND user_id=$2 AND remind_at=$3 LIMIT 1",
            [c.tender_id, req.identity.userId, at],
          )
        ).rows[0],
        row =
          existing ||
          (
            await pool.query(
              "INSERT INTO tender.reminders(tender_id,user_id,remind_at) VALUES($1,$2,$3) RETURNING id",
              [c.tender_id, req.identity.userId, at],
            )
          ).rows[0];
      await pool.query(
        "INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'internal_deadline_adopted',$2,$3)",
        [
          req.identity.userId,
          c.tender_id,
          {
            ...c,
            reminderId: row.id,
            deadlineType: req.body?.deadline_type,
            deadlineSource: req.body?.deadline_source,
            externalWrite: false,
          },
        ],
      );
      return {
        ok: true,
        id: row.id,
        idempotent: Boolean(existing),
        request_id: crypto.randomUUID(),
      };
    },
  );
  app.post(
    "/api/management-inbox/actions/:tenderId/reminder",
    { preHandler: [requirePermission("tender.deadline.manage"), csrf] },
    async (req, reply) => {
      const c = await validateActionContext(req, reply);
      if (!c) return;
      const at = req.body?.remind_at;
      if (!at)
        return reply
          .code(400)
          .send({
            error: "reminder_required",
            message: "Ein Wiedervorlagezeitpunkt ist erforderlich.",
          });
      const existing=(await pool.query("SELECT id FROM tender.reminders WHERE tender_id=$1 AND user_id=$2 AND remind_at=$3 LIMIT 1",[c.tender_id,req.identity.userId,at])).rows[0],row=existing||(await pool.query(
          "INSERT INTO tender.reminders(tender_id,user_id,remind_at) VALUES($1,$2,$3) RETURNING id",
          [c.tender_id, req.identity.userId, at],
        )).rows[0];
      await pool.query(
        "INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'reminder_created',$2,$3)",
        [
          req.identity.userId,
          c.tender_id,
          {
            ...c,
            reminderId: row.id,
            reason: String(req.body?.reason || "").slice(0, 500),
            externalWrite: false,
          },
        ],
      );
      return reply.code(existing?200:201).send({ ok: true, id: row.id,idempotent:Boolean(existing), request_id: crypto.randomUUID() });
    },
  );
  const fullReviewContext = async (tenderId, companyId) => {
    const tender = (
      await pool.query(
        "SELECT * FROM tender.tenders WHERE id=$1 AND data_class='PUBLIC_REAL'",
        [tenderId],
      )
    ).rows[0];
    const company = (
      await pool.query(
        "SELECT * FROM tender.enterprise_company_links WHERE company_id=$1 AND active=true",
        [companyId],
      )
    ).rows[0];
    if (!tender || !company) return null;
    const [
      region,
      lots,
      requirements,
      documents,
      parameters,
      profile,
      costConfig,
      count,
      enrichment,
    ] = await Promise.all([
      pool.query(
        "SELECT * FROM tender.region_evaluations WHERE tender_id=$1 AND company_id=$2 AND lot_id IS NULL ORDER BY evaluation_version DESC LIMIT 1",
        [tenderId, companyId],
      ),
      pool.query(
        "SELECT * FROM tender.lots WHERE tender_id=$1 ORDER BY external_id",
        [tenderId],
      ),
      pool.query(
        "SELECT * FROM tender.requirements WHERE tender_id=$1 ORDER BY created_at",
        [tenderId],
      ),
      pool.query(
        "SELECT id,display_name,source_url,sha256,created_at FROM tender.documents WHERE tender_id=$1 ORDER BY created_at",
        [tenderId],
      ),
      pool.query(
        `SELECT a.parameter_key,c.new_value,c.unit,c.valid_from,c.valid_until FROM tender.configuration_active_parameters a JOIN tender.configuration_changes c ON c.id=a.change_id WHERE a.company_id=$1 ORDER BY a.parameter_key`,
        [companyId],
      ),
      pool.query(
        "SELECT p.* FROM tender.enterprise_company_links l JOIN tender.company_profiles p ON p.id=l.tender_profile_id WHERE l.company_id=$1 AND l.active=true LIMIT 1",
        [companyId],
      ),
      pool.query(
        "SELECT * FROM tender.cost_configurations WHERE company_id=$1 AND status='ACTIVE' ORDER BY version DESC LIMIT 1",
        [companyId],
      ),
      pool.query(
        "SELECT count(*)::int n FROM tender.evaluations WHERE tender_id=$1 AND explanation->>'reviewType' IN ('FULL_TENDER_REVIEW','FULL_TENDER_AUTOPILOT') AND explanation->>'companyId'=$2",
        [tenderId, String(companyId)],
      ),
      pool.query(
        "SELECT * FROM tender.enrichment_versions WHERE tender_id=$1 ORDER BY version DESC LIMIT 1",
        [tenderId],
      ),
    ]);
    const enriched = enrichment.rows[0] || null,
      enrichmentFields = enriched
        ? (
            await pool.query(
              "SELECT * FROM tender.enrichment_fields WHERE enrichment_version_id=$1 ORDER BY field_key",
              [enriched.id],
            )
          ).rows
        : [],
      enrichmentDocuments = enriched
        ? (
            await pool.query(
              "SELECT id,source_url,document_type,filename,fetch_status,http_status,mime_type,payload_sha256,parser,parser_version,retrieved_at,provenance FROM tender.enrichment_documents WHERE enrichment_version_id=$1 ORDER BY filename NULLS LAST,source_url",
              [enriched.id],
            )
          ).rows
        : [];
    return {
      tender,
      company,
      region: region.rows[0],
      lots: lots.rows,
      requirements: requirements.rows,
      documents: documents.rows,
      parameters: parameters.rows,
      profile: profile.rows[0],
      costConfig: costConfig.rows[0],
      enrichment: enriched,
      enrichmentFields,
      enrichmentDocuments,
      version: count.rows[0].n + 1,
    };
  };
  app.post(
    "/api/management-inbox/full-review/:tenderId",
    { preHandler: [requirePermission("tender.evaluate"), csrf] },
    async (req, reply) => {
      const companies = await accessibleCompanies(req.identity),
        company = companies.find(
          (x) => String(x.company_id) === String(req.query?.company || ""),
        );
      if (!company)
        return reply.code(403).send({ error: "company_scope_forbidden" });
      if (!(await requireRegisteredScope(reply, req.params.tenderId, company.company_id))) return;
      const context = await fullReviewContext(
        req.params.tenderId,
        company.company_id,
      );
      if (!context || !context.region)
        return reply.code(404).send({ error: "review_context_not_found" });
      const review = buildFullTenderReview(context);
      await pool.query(
        "INSERT INTO tender.evaluations(tender_id,actor_id,score,explanation) VALUES($1,$2,NULL,$3)",
        [
          req.params.tenderId,
          req.identity.userId,
          {
            reviewType: "FULL_TENDER_REVIEW",
            companyId: String(company.company_id),
            lotKey: String(req.query?.lot || ""),
            evaluationVersion: review.evaluationVersion,
            review,
          },
        ],
      );
      await pool.query(
        "INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'full_tender_review_created',$2,$3)",
        [
          req.identity.userId,
          req.params.tenderId,
          {
            companyId: company.company_id,
            evaluationVersion: review.evaluationVersion,
            derivedOnly: true,
            externalWrite: false,
          },
        ],
      );
      return reply.code(201).send(review);
    },
  );
  app.get(
    "/api/management-inbox/full-review/:tenderId/export",
    { preHandler: requirePermission("tender.inbox.view") },
    async (req, reply) => {
      const companies = await accessibleCompanies(req.identity),
        company = companies.find(
          (x) => String(x.company_id) === String(req.query?.company || ""),
        );
      if (!company)
        return reply.code(403).send({ error: "company_scope_forbidden" });
      if (!(await requireRegisteredScope(reply, req.params.tenderId, company.company_id))) return;
      const row = (
        await pool.query(
          "SELECT explanation FROM tender.evaluations WHERE tender_id=$1 AND explanation->>'reviewType' IN ('FULL_TENDER_REVIEW','FULL_TENDER_AUTOPILOT') AND explanation->>'companyId'=$2 AND coalesce(explanation->>'lotKey','')=$3 ORDER BY created_at DESC LIMIT 1",
          [req.params.tenderId, String(company.company_id),String(req.query?.lot||"")],
        )
      ).rows[0];
      if (!row) return reply.code(404).send({ error: "full_review_not_found" });
      return reply
        .header(
          "content-disposition",
          `attachment; filename=WB-Tender-Pruefbericht-${req.params.tenderId}.json`,
        )
        .type("application/json")
        .send(row.explanation.review);
    },
  );
  const actionTypes = new Set([
    "TEST_PORTAL_CONNECTION",
    "TEST_DOCUMENT_FETCH",
    "RESOLVE_TARGET_PORTAL",
    "VALIDATE_PORTAL_ADAPTER",
    "FETCH_DOCUMENTS",
    "ANALYZE_DOCUMENTS",
    "REFRESH_ENRICHMENT",
    "VALIDATE_CALCULATION_INPUTS",
    "START_CALCULATION",
    "REFRESH_REVIEW",
    "GENERATE_RECOMMENDATION",
    "RUN_FULL_PIPELINE",
    "GENERATE_BOARD_REPORT",
    "EXPORT_REVIEW_REPORT",
    "EXPORT_BOARD_BRIEF",
  ]);
  app.get("/api/autopilot/dlq-summary", { preHandler: read }, async () => {
    const summary = (
        await pool.query("SELECT * FROM tender.current_dlq_operational_summary")
      ).rows[0] || {
        current_unresolved: 0,
        historical_resolved: 0,
        historical_obsolete: 0,
        external_portal_failures: 0,
        manual_review_required: 0,
        historical_audit_total: 0,
        last_classified_at: null,
      },
      classifications = (
        await pool.query(
          "SELECT resolution,count(*)::int count FROM tender.autopilot_dlq_classifications GROUP BY resolution ORDER BY resolution",
        )
      ).rows;
    return {
      summary,
      classifications,
      historyRetained: true,
      rawHistoricalEvents: Number(summary.historical_audit_total || 0),
    };
  });
  const publicJob = (row) => ({
    job_id: row.id,
    request_id: row.request_id,
    action_type: row.action_type,
    status:
      {
        PENDING: "QUEUED",
        CLAIMED: "RUNNING",
        DONE: "SUCCEEDED",
        DEAD_LETTER: "FAILED",
      }[row.status] || row.status,
    queue_status: row.status,
    current_step: row.current_step,
    progress_percent: row.progress_percent,
    last_successful_step: row.last_successful_step,
    next_step: row.next_step,
    calculation_status: row.calculation_status,
    blocking_reason: row.blocking_reason,
    missing_calculation_inputs: row.missing_calculation_inputs || [],
    document_portal: row.document_portal,
    portal_access_status: row.portal_access_status,
    document_resolution_status: row.document_resolution_status,
    documents_found: row.documents_found,
    documents_downloaded: row.documents_downloaded,
    documents_analyzed: row.documents_analyzed,
    total_items: row.total_items,
    successful_items: row.successful_items,
    skipped_items: row.skipped_items,
    failed_items: row.failed_items,
    result_summary: row.result_summary,
    error_code: row.error_code,
    error_detail_safe: row.error_detail_safe,
    timeout_at: row.timeout_at,
    last_progress_at: row.last_progress_at,
    terminal_at: row.terminal_at,
    terminal_result: row.terminal_result,
    created_at: row.created_at,
    next_attempt_at: row.next_attempt_at,
    claimed_at: row.claimed_at,
    started_at: row.started_at,
    heartbeat_at: row.heartbeat_at,
    finished_at: row.finished_at,
    attempt: row.attempt,
  });
  app.post(
    "/api/portal-access/:portalId/login-continuations",
    {
      preHandler: [
        requirePermission(["tender.portal.manage", "tender.admin"]),
        csrf,
      ],
    },
    async (req, reply) => {
      const tender = await visibleTender(req, reply, req.body?.tender_id);
      if (!tender) return;
      const requestedCompany = String(req.body?.company_id || ""),
        companies = await accessibleCompanies(req.identity),
        company = companies.find(x => String(x.company_id) === requestedCompany),
        portal = await portalRow(req.params.portalId),
        credential = portal && company && (await activeCredentialForCompany(portal.id, company.company_id));
      if (!company)
        return reply.code(403).send({ error: "company_scope_forbidden" });
      if (!portal || !portal.adapter_enabled)
        return reply.code(409).send({ error: "PORTAL_ADAPTER_NOT_AVAILABLE" });
      if (
        portal.login_strategy === "PUBLIC_DOCUMENT_ACCESS" ||
        (portal.capabilities || []).includes("PUBLIC_DOCUMENTS_POSSIBLE")
      )
        return reply.code(409).send({
          error: "PORTAL_AUTHENTICATION_NOT_REQUIRED",
          message:
            "Dieses Portalprofil stellt Vergabeunterlagen öffentlich bereit. Portal öffnen oder Dokumente aktualisieren verwenden.",
        });
      if (!credential)
        return reply
          .code(409)
          .send({ error: "PORTALZUGANG_NICHT_KONFIGURIERT" });
      const registeredScope = await requireRegisteredScope(
        reply,
        tender.id,
        company.company_id,
      );
      if (!registeredScope) return;
      if (
        String(registeredScope.portal_id) !== String(portal.id) ||
        String(registeredScope.credential_id) !== String(credential.id)
      )
        return reply.code(404).send({
          error: "registered_portal_scope_not_found",
          message: "Keine Ausschreibungen aus registrierten Portalen vorhanden",
          externalSubmissionEnabled: false,
          transmitted: false,
        });
      const lotKey = String(req.body?.lot_key || "") || null;
      if (
        lotKey &&
        !(
          await pool.query(
            "SELECT 1 FROM tender.lots WHERE tender_id=$1 AND external_id=$2 UNION ALL SELECT 1 FROM tender.enrichment_lots l JOIN tender.enrichment_versions e ON e.id=l.enrichment_version_id WHERE e.tender_id=$1 AND l.lot_key=$2 LIMIT 1",
            [tender.id, lotKey],
          )
        ).rowCount
      )
        return reply.code(409).send({ error: "LOT_CONTEXT_INVALID" });
      const domains = portalHosts(portal),
        document = (
          await pool.query(
            `SELECT d.source_url,d.provenance,e.id enrichment_version_id,e.notice_version,t.notice_number,t.external_id,tv.id tender_version_id
      FROM tender.enrichment_documents d JOIN tender.enrichment_versions e ON e.id=d.enrichment_version_id JOIN tender.tenders t ON t.id=e.tender_id JOIN LATERAL(SELECT id FROM tender.tender_versions WHERE tender_id=t.id ORDER BY version DESC LIMIT 1)tv ON true
      WHERE e.tender_id=$1 AND (d.provenance->>'portalId'=$2 OR lower(split_part(split_part(d.source_url,'://',2),'/',1))=ANY($3::text[]) OR lower(coalesce(d.provenance->>'targetPortal',''))=ANY($3::text[]))
      ORDER BY e.version DESC,CASE WHEN nullif(d.provenance->>'documentArea','') IS NOT NULL THEN 0 ELSE 1 END,d.retrieved_at DESC NULLS LAST LIMIT 1`,
            [tender.id, String(portal.id), domains],
          )
        ).rows[0];
      if (!document)
        return reply
          .code(409)
          .send({ error: "KEINE_PASSENDE_AUSSCHREIBUNG_GEFUNDEN" });
      const target = externalLoginTarget(portal),
        auditId = crypto.randomUUID(),
        client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE tender.portal_login_continuations SET status='SESSION_EXPIRED' WHERE user_id=$1 AND tender_id=$2 AND coalesce(lot_key,'')=coalesce($3,'') AND portal_id=$4 AND company_id=$5 AND status IN('LOGIN_STARTED','WAITING_FOR_USER','MFA_REQUIRED')`,
          [req.identity.userId, tender.id, lotKey, portal.id, company.company_id],
        );
        const loginRequestId = crypto.randomUUID(),
          loginReason = "MANAGED_PORTAL_AUTHENTICATION",
          loginKey = [
            "AUTO_PORTAL_LOGIN",
            tender.id,
            lotKey || "_tender",
            company.company_id,
            portal.id,
            document.enrichment_version_id,
          ].join(":");
        let loginJob =
            (
              await client.query(
                `SELECT * FROM tender.autopilot_queue WHERE tender_id=$1 AND tender_version_id=$2 AND reason=$3 AND lot_key IS NOT DISTINCT FROM $4 AND company_id=$5 AND credential_id=$6 AND status IN('PENDING','CLAIMED','RETRY','QUEUED','RUNNING') FOR UPDATE`,
                [tender.id, document.tender_version_id, loginReason,lotKey,company.company_id,credential.id],
              )
            ).rows[0] || null,
          loginJobDisposition = loginJob ? "REUSED_ACTIVE" : "CREATED";
        const activeLoginStates = new Set([
          "PENDING",
          "CLAIMED",
          "RETRY",
          "QUEUED",
          "RUNNING",
        ]);
        if (!loginJob) {
          loginJob = (
            await client.query(
              `INSERT INTO tender.autopilot_queue(request_id,action_type,tender_id,tender_version_id,notice_id,lot_key,company_id,service_scope,portal_id,credential_id,enrichment_version_id,adapter_id,adapter_version,idempotency_key,reason,status,current_step,created_by)
        VALUES($1,'START_PORTAL_AUTHENTICATION',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'QUEUED','AUTHENTICATION_PENDING',$15) RETURNING *`,
              [
                loginRequestId,
                tender.id,
                document.tender_version_id,
                document.notice_number ||
                  document.external_id ||
                  document.notice_version ||
                  null,
                lotKey,
                company.company_id,
                company.service_line,
                portal.id,
                credential.id,
                document.enrichment_version_id,
                portal.adapter_id,
                portal.adapter_version,
                loginKey,
                loginReason,
                req.identity.userId,
              ],
            )
          ).rows[0];
        } else if (!activeLoginStates.has(loginJob.status)) {
          loginJobDisposition = "REACTIVATED_TERMINAL";
          loginJob = (
            await client.query(
              `UPDATE tender.autopilot_queue SET request_id=$2,action_type='START_PORTAL_AUTHENTICATION',notice_id=$3,lot_key=$4,company_id=$5,service_scope=$6,portal_id=$7,credential_id=$8,enrichment_version_id=$9,adapter_id=$10,adapter_version=$11,idempotency_key=$12,status='QUEUED',current_step='AUTHENTICATION_PENDING',attempt=coalesce(attempt,0)+1,next_attempt_at=now(),claimed_at=NULL,started_at=NULL,heartbeat_at=NULL,finished_at=NULL,worker_id=NULL,error_code=NULL,error_detail_safe=NULL,blocking_reason=NULL,created_by=$13 WHERE id=$1 RETURNING *`,
              [
                loginJob.id,
                loginRequestId,
                document.notice_number ||
                  document.external_id ||
                  document.notice_version ||
                  null,
                lotKey,
                company.company_id,
                company.service_line,
                portal.id,
                credential.id,
                document.enrichment_version_id,
                portal.adapter_id,
                portal.adapter_version,
                loginKey,
                req.identity.userId,
              ],
            )
          ).rows[0];
        }
        const row = (
          await client.query(
            `INSERT INTO tender.portal_login_continuations(tender_id,notice_id,lot_key,company_id,portal_id,portal_adapter_id,credential_id,expected_portal_host,expected_partner_host,portal_login_url,portal_tender_url,partner_system_url,user_id,status,audit_id,login_job_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'LOGIN_STARTED',$14,$15) RETURNING *`,
            [
              tender.id,
              document.notice_number ||
                document.external_id ||
                document.notice_version ||
                null,
              lotKey,
              company.company_id,
              portal.id,
              portal.adapter_id,
              credential.id,
              target.expectedPortalHost,
              target.expectedPartnerHost,
              target.portalLoginUrl,
              target.portalTenderUrl,
              target.partnerSystemUrl,
              req.identity.userId,
              auditId,
              loginJob.id,
            ],
          )
        ).rows[0];
        await client.query(
          "INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'external_portal_login_started',$2,$3::jsonb)",
          [
            req.identity.userId,
            tender.id,
            JSON.stringify({
              continuationId: row.id,
              loginJobId: loginJob.id,
              loginJobDisposition,
              loginAttempt: loginJob.attempt,
              noticeId: row.notice_id,
              lotKey,
              portalId: portal.id,
              portalAdapterId: portal.adapter_id,
              credentialId: credential.id,
              expectedPortalHost: target.expectedPortalHost,
              expectedPartnerHost: target.expectedPartnerHost,
              desiredAction: "VERIFY_SESSION_THEN_FANOUT",
              auditId,
              externalWrite: false,
            }),
          ],
        );
        await client.query("COMMIT");
        return reply
          .code(201)
          .send({
            continuationId: row.id,
            tenderId: tender.id,
            noticeId: row.notice_id,
            lotKey,
            companyId: company.company_id,
            portalAdapterId: portal.adapter_id,
            credentialId: credential.id,
            portalHost: target.expectedPortalHost,
            portalLoginUrl: target.portalLoginUrl,
            portalTenderUrl: target.portalTenderUrl,
            partnerSystemUrl: target.partnerSystemUrl,
            externalUrl: target.externalUrl,
            status: row.status,
            expiresAt: row.expires_at,
            auditId,
          });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );
  app.post(
    "/api/portal-access/login-continuations/:continuationId/status",
    {
      preHandler: [
        requirePermission(["tender.portal.manage", "tender.admin"]),
        csrf,
      ],
    },
    async (req, reply) => {
      const continuation = (
        await pool.query(
          "SELECT * FROM tender.portal_login_continuations WHERE id=$1 AND (user_id=$2 OR $3::boolean)",
          [
            req.params.continuationId,
            req.identity.userId,
            req.identity.permissions.includes("tender.admin"),
          ],
        )
      ).rows[0];
      if (!continuation)
        return reply.code(404).send({ error: "LOGIN_CONTINUATION_NOT_FOUND" });
      if (
        !continuation.company_id ||
        (!req.identity.permissions.includes("tender.admin") &&
          !req.identity.companyIds.includes(String(continuation.company_id)))
      )
        return reply.code(403).send({ error: "company_scope_forbidden" });
      if (
        new Date(continuation.expires_at) <= new Date() &&
        !["LOGIN_SUCCESSFUL", "LOGIN_FAILED"].includes(continuation.status)
      ) {
        await pool.query(
          "UPDATE tender.portal_login_continuations SET status='SESSION_EXPIRED' WHERE id=$1",
          [continuation.id],
        );
        return {
          continuationId: continuation.id,
          status: "SESSION_EXPIRED",
          expiresAt: continuation.expires_at,
        };
      }
      const session = (
        await pool.query(
          "SELECT session.id FROM tender.portal_read_sessions session JOIN tender.portal_credential_secrets credential ON credential.id=session.credential_id JOIN tender.portal_credential_companies scope ON scope.credential_id=session.credential_id AND scope.company_id=session.company_id WHERE session.portal_id=$1 AND session.credential_id=$2 AND session.company_id=$3 AND tender.portal_session_effective_status(session.status,session.expires_at,session.revoked_at,session.verification_status)='ACTIVE' AND session.last_verified_at IS NOT NULL AND coalesce(session.cookie_count,0)>0 AND credential.status='ACTIVE' AND scope.active=true ORDER BY session.last_verified_at DESC LIMIT 1",
          [continuation.portal_id, continuation.credential_id, continuation.company_id],
        )
      ).rows[0];
      if (!session) {
        const loginJob = continuation.login_job_id
          ? (
              await pool.query(
                "SELECT status,current_step,error_code FROM tender.autopilot_queue WHERE id=$1",
                [continuation.login_job_id],
              )
            ).rows[0]
          : null;
        if (loginJob && ["FAILED", "DEAD_LETTER"].includes(loginJob.status)) {
          const status =
            loginJob.error_code === "MFA_BESTÄTIGUNG_ERFORDERLICH"
              ? "MFA_REQUIRED"
              : loginJob.error_code === "BENUTZERNAME_ODER_PASSWORT_FALSCH"
                ? "WRONG_ACCOUNT_CONTEXT"
                : loginJob.error_code === "LOGIN_FORMULAR_GEAENDERT"
                  ? "LOGIN_FORM_CHANGED"
                  : "LOGIN_FAILED";
          await pool.query(
            "UPDATE tender.portal_login_continuations SET status=$2 WHERE id=$1",
            [continuation.id, status],
          );
          return {
            continuationId: continuation.id,
            status,
            loginJobStatus: loginJob.status,
            errorClass: loginJob.error_code,
            expiresAt: continuation.expires_at,
          };
        }
        await pool.query("UPDATE tender.portal_login_continuations SET status='SESSION_EXPIRED' WHERE id=$1 AND status IN('LOGIN_STARTED','WAITING_FOR_USER','LOGIN_SUCCESSFUL')",[continuation.id]);
        return {
          continuationId: continuation.id,
          status: "SESSION_EXPIRED",
          sessionValid: false,
          recoveryAction: { type: "START_LOGIN", label: "Erneut anmelden" },
          loginJobStatus: loginJob?.status || null,
          currentStep: loginJob?.current_step || null,
          expiresAt: continuation.expires_at,
        };
      }
      await enqueueVerifiedSessionFanout(pool,session.id);
      const fanout = (
        await pool.query(
          `SELECT dispatch.tender_id,dispatch.company_id,dispatch.lot_key,dispatch.job_id,
            job.status,job.current_step,job.document_resolution_status,job.documents_found,
            job.documents_downloaded,job.documents_analyzed,job.error_code,job.error_detail_safe
           FROM tender.portal_session_context_dispatches dispatch
           JOIN tender.autopilot_queue job ON job.id=dispatch.job_id
           WHERE dispatch.session_id=$1 AND dispatch.portal_id=$2
             AND dispatch.company_id=$3 AND dispatch.credential_id=$4
           ORDER BY dispatch.tender_id,dispatch.lot_key`,
          [session.id,continuation.portal_id,continuation.company_id,continuation.credential_id],
        )
      ).rows;
      const job = fanout.find(item =>
        String(item.tender_id) === String(continuation.tender_id) &&
        String(item.lot_key || "") === String(continuation.lot_key || ""),
      );
      if (!job)
        return reply.code(409).send({
          error: "CONTINUATION_CONTEXT_INVALID",
          sessionValid: true,
          affectedContexts: fanout.map(publicJob),
        });
      await pool.query(
        "UPDATE tender.portal_login_continuations SET status='LOGIN_SUCCESSFUL',job_id=$2,completed_at=coalesce(completed_at,now()) WHERE id=$1",
        [continuation.id,job.job_id],
      );
      await pool.query(
        "INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'verified_portal_session_fanout_observed',$2,$3::jsonb)",
        [continuation.user_id,continuation.tender_id,JSON.stringify({
          continuationId: continuation.id,
          portalId: continuation.portal_id,
          credentialId: continuation.credential_id,
          companyId: continuation.company_id,
          sessionId: session.id,
          affectedContexts: fanout.length,
          externalWrite: false,
          transmitted: false,
        })],
      );
      const technicalDocumentStates=new Set(['DOWNLOAD_FAILED','PORTAL_ACCESS_REQUIRED','SESSION_NICHT_FUER_DOWNLOAD_GUELTIG','DOWNLOADLINK_NICHT_AUFGELOEST']),processingState=job.status==='QUEUED'?'AUTOMATIC_PROCESSING_PLANNED':['PENDING','CLAIMED','RETRY','RUNNING'].includes(job.status)?(job.current_step==='DOCUMENT_DOWNLOAD'?'DOCUMENT_DOWNLOAD_ACTIVE':'AUTOMATIC_PROCESSING_ACTIVE'):technicalDocumentStates.has(job.document_resolution_status)||job.error_code?'TECHNICAL_BLOCKER':['SUCCEEDED','DONE'].includes(job.status)?(Number(job.documents_found)>0&&Number(job.documents_downloaded)>=Number(job.documents_found)&&Number(job.documents_analyzed)>=Number(job.documents_downloaded)?'DOCUMENT_WORKFLOW_COMPLETED':'FUNCTIONAL_BLOCKER_REACHED'):'TECHNICAL_BLOCKER';
      return {
        continuationId: continuation.id,
        status: processingState,
        sessionValid: Boolean(session),
        nextState: "PORTAL_SESSION_ESTABLISHED",
        resumeAction: "RESUME_DOCUMENT_FETCH",
        job: publicJob({ ...job, id: job.job_id }),
        affectedContexts: fanout.map(item => publicJob({ ...item, id: item.job_id })),
      };
    },
  );
  app.post(
    "/api/management-inbox/autopilot/:tenderId/jobs",
    { preHandler: [requirePermission("tender.evaluate"), csrf] },
    async (req, reply) => {
      const body = req.body || {},
        action = String(body.action_type || "");
      if (!actionTypes.has(action))
        return reply.code(400).send({ error: "invalid_action_type" });
      const requiredContext = [
          "tender_id",
          "tender_version_id",
          "notice_id",
          "lot_id",
          "company_id",
          "service_scope",
          "enrichment_version_id",
          "assessment_version_id",
          "configuration_version_id",
        ],
        missingContext =
          action === "RUN_FULL_PIPELINE"
            ? []
            : requiredContext.filter(
                (key) =>
                  body[key] === null ||
                  body[key] === undefined ||
                  body[key] === "",
              );
      if (missingContext.length)
        return reply
          .code(409)
          .send({
            error: "FEHLENDER_TENDERKONTEXT",
            missing_fields: missingContext,
            message: `Erforderlicher Aktionskontext fehlt: ${missingContext.join(", ")}`,
          });
      if (
        body.tender_id &&
        String(body.tender_id) !== String(req.params.tenderId)
      )
        return reply.code(409).send({ error: "FALSCHER_TENDERKONTEXT" });
      const companies = await accessibleCompanies(req.identity),
        company = companies.find(
          (x) =>
            String(x.company_id) ===
            String(body.company_id || req.query?.company || ""),
        );
      if (!company)
        return reply.code(403).send({ error: "company_scope_forbidden" });
      const registeredScope = await requireRegisteredScope(
        reply,
        req.params.tenderId,
        company.company_id,
      );
      if (!registeredScope) return;
      const tender = (
        await pool.query(
          "SELECT id,notice_number,external_id FROM tender.tenders WHERE id=$1",
          [req.params.tenderId],
        )
      ).rows[0];
      if (!tender)
        return reply.code(404).send({ error: "FEHLENDER_TENDERKONTEXT" });
      const tenderVersion = (
        await pool.query(
          "SELECT id FROM tender.tender_versions WHERE tender_id=$1 ORDER BY version DESC LIMIT 1",
          [tender.id],
        )
      ).rows[0];
      if (!tenderVersion)
        return reply.code(409).send({ error: "FEHLENDER_TENDERKONTEXT" });
      if (
        (body.tender_version_id &&
          String(tenderVersion.id) !== String(body.tender_version_id)) ||
        (body.notice_id &&
          String(tender.notice_number || tender.external_id) !==
            String(body.notice_id))
      )
        return reply
          .code(409)
          .send({
            error: "VERALTETER_TENDERKONTEXT",
            message:
              "Tender- oder Bekanntmachungsversion ist nicht mehr aktiv.",
          });
      const lot = body.lot_id
        ? (
            await pool.query(
              "SELECT id,external_id FROM tender.lots WHERE id=$1 AND tender_id=$2 UNION ALL SELECT el.id,el.lot_key external_id FROM tender.enrichment_lots el JOIN tender.enrichment_versions ev ON ev.id=el.enrichment_version_id WHERE el.id=$1 AND ev.tender_id=$2 ORDER BY id LIMIT 1",
              [body.lot_id, tender.id],
            )
          ).rows[0]
        : body.lot_key
          ? (
              await pool.query(
                "SELECT el.id,el.lot_key external_id FROM tender.enrichment_lots el JOIN tender.enrichment_versions ev ON ev.id=el.enrichment_version_id WHERE ev.tender_id=$1 AND el.lot_key=$2 ORDER BY ev.version DESC LIMIT 1",
                [tender.id, body.lot_key],
              )
            ).rows[0]
          : null;
      if ((body.lot_id || body.lot_key) && !lot)
        return reply
          .code(409)
          .send({
            error: "FEHLENDER_TENDERKONTEXT",
            missing_fields: ["lot_id"],
            message:
              "Das ausgewählte Los gehört nicht zur aktiven Tenderversion.",
          });
      if (body.portal_id && String(body.portal_id) !== String(registeredScope.portal_id))
        return reply.code(409).send({ error: "FALSCHER_PORTALKONTEXT" });
      const portal = { id: registeredScope.portal_id },
        credential = { id: registeredScope.credential_id };
      const relevance = (
        await pool.query(
          "SELECT * FROM tender.current_service_relevance WHERE tender_id=$1 AND company_id=$2 AND lot_key IS NOT DISTINCT FROM $3",
          [tender.id, company.company_id, body.lot_key ?? null],
        )
      ).rows[0];
      if (
        action === "RUN_FULL_PIPELINE" &&
        (!relevance ||
          relevance.relevance_status !== "RELEVANT" ||
          relevance.service_scope_gate !== "PASSED" ||
          relevance.recommendation !== "FULL_PIPELINE_ALLOWED" ||
          !relevance.primary_company)
      )
        return reply
          .code(409)
          .send({
            error: "NOT_ELIGIBLE",
            message:
              "Die vollständige Verarbeitung ist für diesen Gesellschafts-/Loskontext nicht freigegeben.",
          });
      const enrichment = body.enrichment_version_id
        ? (
            await pool.query(
              "SELECT id,version FROM tender.enrichment_versions WHERE id=$1 AND tender_id=$2",
              [body.enrichment_version_id, tender.id],
            )
          ).rows[0]
        : (
            await pool.query(
              "SELECT id,version FROM tender.enrichment_versions WHERE tender_id=$1 ORDER BY version DESC LIMIT 1",
              [tender.id],
            )
          ).rows[0];
      const assessment =
          action === "RUN_FULL_PIPELINE"
            ? relevance.evaluation_version
            : Number(body.assessment_version_id) || null,
        configurationVersion = String(
          (
            await pool.query(
              "SELECT max(configuration_version_no) v FROM tender.region_evaluations WHERE tender_id=$1 AND company_id=$2",
              [tender.id, company.company_id],
            )
          ).rows[0]?.v ?? "UNVERSIONED",
        ),
        pipelineContext =
          action === "RUN_FULL_PIPELINE"
            ? (
                await pool.query(
                  "SELECT completed_steps FROM tender.pipeline_contexts WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3 AND pipeline_version=$4",
                  [
                    tender.id,
                    company.company_id,
                    body.lot_key || "",
                    PIPELINE_SCHEMA_VERSION,
                  ],
                )
              ).rows[0]
            : null,
        completedCanonicalSteps = new Set(
          pipelineContext?.completed_steps || [],
        ),
        nextCanonicalStep =
          PIPELINE_STEPS.find((step) => !completedCanonicalSteps.has(step)) ||
          "BOARD_BRIEF_GENERATED",
        parts =
          action === "RUN_FULL_PIPELINE"
            ? [
                tender.id,
                body.lot_key || "_tender",
                company.company_id,
                PIPELINE_SCHEMA_VERSION,
                nextCanonicalStep,
              ]
            : [
                action,
                tender.id,
                tenderVersion.id,
                body.lot_key ?? lot?.id ?? "-",
                company.company_id,
                enrichment?.id || "-",
                assessment || "-",
                configurationVersion,
              ];
      const key = parts.join(":");
      const requestId = crypto.randomUUID(),
        client = await pool.connect();
      try {
        await client.query("BEGIN");
        const existing = (
          await client.query(
            "SELECT * FROM tender.autopilot_queue WHERE idempotency_key=$1 AND status IN ('PENDING','CLAIMED','RETRY','QUEUED','RUNNING') FOR UPDATE",
            [key],
          )
        ).rows[0];
        if (existing) {
          await client.query("COMMIT");
          return reply
            .code(200)
            .send({ ...publicJob(existing), deduplicated: true });
        }
        const row = (
          await client.query(
            `INSERT INTO tender.autopilot_queue(request_id,action_type,tender_id,tender_version_id,notice_id,lot_id,company_id,service_scope,portal_id,credential_id,enrichment_version_id,assessment_version_id,idempotency_key,reason,status,current_step,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'QUEUED','QUEUED',$15) RETURNING *`,
            [
              requestId,
              action,
              tender.id,
              tenderVersion.id,
              tender.notice_number || tender.external_id,
              lot?.id || null,
              company.company_id,
              String(
                body.service_scope ||
                  relevance?.service_line ||
                  company.service_line ||
                  "",
              ) || null,
              portal?.id || null,
              credential?.id || null,
              enrichment?.id || null,
              assessment,
              key,
              `ACTION_${action}_${requestId}`,
              req.identity.userId,
            ],
          )
        ).rows[0];
        if (action === "RUN_FULL_PIPELINE")
          await client.query(
            "UPDATE tender.autopilot_queue SET lot_key=$2,configuration_version_id=$3,calculation_status='DOCUMENT_FETCH_QUEUED',next_step='FETCH_DOCUMENTS' WHERE id=$1",
            [row.id, body.lot_key ?? null, configurationVersion],
          );
        await client.query(
          "INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'autopilot_action_queued',$2,$3::jsonb)",
          [
            req.identity.userId,
            tender.id,
            JSON.stringify({
              jobId: row.id,
              requestId,
              actionType: action,
              companyId: company.company_id,
              lotId: lot?.id || null,
              portalId: portal?.id || null,
              externalWrite: false,
            }),
          ],
        );
        await client.query("COMMIT");
        return reply.code(202).send({ ...publicJob(row), deduplicated: false });
      } catch (error) {
        await client.query("ROLLBACK");
        if (
          error.code === "23505" &&
          error.constraint === "autopilot_queue_active_idempotency_idx"
        ) {
          const row = (
            await pool.query(
              "SELECT * FROM tender.autopilot_queue WHERE idempotency_key=$1 AND status IN ('PENDING','CLAIMED','RETRY','QUEUED','RUNNING')",
              [key],
            )
          ).rows[0];
          if (row)
            return reply
              .code(200)
              .send({ ...publicJob(row), deduplicated: true });
        }
        throw error;
      } finally {
        client.release();
      }
    },
  );
  app.get(
    "/api/management-inbox/autopilot/jobs/:jobId",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
          keyGenerator: (req) =>
            `${crypto
              .createHash("sha256")
              .update(String(req.cookies?.wb_session || "anonymous"))
              .digest("hex")}:${String(req.params.jobId || "")}`,
        },
      },
      preHandler: read,
    },
    async (req, reply) => {
      const row = (
        await pool.query("SELECT * FROM tender.autopilot_queue WHERE id=$1", [
          req.params.jobId,
        ])
      ).rows[0];
      if (!row) return reply.code(404).send({ error: "job_not_found" });
      const companies = await accessibleCompanies(req.identity);
      if (
        row.company_id &&
        !companies.some((x) => String(x.company_id) === String(row.company_id))
      )
        return reply.code(403).send({ error: "company_scope_forbidden" });
      if (row.company_id && !(await requireRegisteredScope(reply, row.tender_id, row.company_id))) return;
      return publicJob(row);
    },
  );
  app.get(
    "/api/management-inbox/autopilot/:tenderId/jobs",
    { preHandler: read },
    async (req, reply) => {
      const companies = await accessibleCompanies(req.identity);
      if (
        !companies.some(
          (x) => String(x.company_id) === String(req.query?.company || ""),
        )
      )
        return reply.code(403).send({ error: "company_scope_forbidden" });
      if (!(await requireRegisteredScope(reply, req.params.tenderId, req.query.company))) return;
      return {
        items: (
          await pool.query(
            "SELECT * FROM tender.autopilot_queue WHERE tender_id=$1 AND company_id=$2 ORDER BY created_at DESC LIMIT 20",
            [req.params.tenderId, req.query.company],
          )
        ).rows.map(publicJob),
      };
    },
  );
  app.post(
    "/api/portal-access/:portalId/jobs",
    {
      preHandler: [
        requirePermission(["tender.portal.manage", "tender.admin"]),
        csrf,
      ],
    },
    async (req, reply) => {
      const action = String(req.body?.action_type || "");
      if (!["TEST_PORTAL_CONNECTION", "TEST_DOCUMENT_FETCH"].includes(action))
        return reply.code(400).send({ error: "invalid_action_type" });
      const portal = await portalRow(req.params.portalId);
      if (!portal)
        return reply.code(404).send({ error: "FEHLENDER_PORTALKONTEXT" });
      if (!portal.adapter_enabled)
        return reply
          .code(409)
          .send({ error: "UNKNOWN_PORTAL_ADAPTER_REQUIRED" });
      const companies = await accessibleCompanies(req.identity),
        requestedCompany = String(req.body?.company_id || ""),
        company = companies.find(
          (x) => String(x.company_id) === requestedCompany,
        ),
        credential = company
          ? await activeCredentialForCompany(portal.id, company.company_id)
          : null;
      if (!company)
        return reply.code(403).send({ error: "company_scope_forbidden" });
      if (!credential)
        return reply
          .code(409)
          .send({ error: "PORTALZUGANG_NICHT_KONFIGURIERT" });
      const domains = [
          portal.canonical_domain,
          ...portal.allowed_subdomains,
          ...portal.authentication_domains,
          ...portal.download_domains,
        ],
        requestedTenderRaw = String(req.body?.tender_id || "").trim(),
        requestedTender = requestedTenderRaw&&validUuid(requestedTenderRaw)?requestedTenderRaw:null;
      if (requestedTenderRaw && !requestedTender)
        return reply.code(400).send({ error: "invalid_tender_id" });
      if (requestedTender && !(await visibleTender(req, reply, requestedTender)))
        return;
      const target = (
          await pool.query(
            `SELECT e.tender_id,tv.id tender_version_id,e.id enrichment_version_id,t.assigned_user_id,t.sector_id,t.company_id FROM tender.enrichment_documents d JOIN tender.enrichment_versions e ON e.id=d.enrichment_version_id JOIN tender.tenders t ON t.id=e.tender_id JOIN LATERAL(SELECT id FROM tender.tender_versions WHERE tender_id=e.tender_id ORDER BY version DESC LIMIT 1)tv ON true WHERE ($3::uuid IS NULL OR e.tender_id=$3) AND EXISTS(SELECT 1 FROM tender.current_service_relevance relevance WHERE relevance.tender_id=e.tender_id AND relevance.company_id=$4 AND relevance.relevance_status='RELEVANT' AND relevance.service_scope_gate='PASSED') AND ($5::boolean OR EXISTS(SELECT 1 FROM tender.current_registered_tender_company_portals registered WHERE registered.tender_id=e.tender_id AND registered.company_id=$4 AND registered.portal_id=$6 AND registered.credential_id=$7)) AND (lower(split_part(split_part(d.source_url,'://',2),'/',1))=ANY($1::text[]) OR lower(coalesce(d.provenance->>'targetPortal',''))=ANY($1::text[]) OR d.provenance->>'portalId'=$2) ORDER BY e.created_at DESC LIMIT 100`,
            [domains, String(portal.id), requestedTender, company.company_id, action === "TEST_PORTAL_CONNECTION", portal.id, credential.id],
          )
        ).rows.find((candidate) => mayView(req.identity, candidate));
      if (!target)
        return reply
          .code(409)
          .send({ error: "KEINE_PASSENDE_AUSSCHREIBUNG_GEFUNDEN" });
      const key = [
          action,
          target.tender_id,
          target.tender_version_id,
          "-",
          company.company_id,
          portal.id,
          target.enrichment_version_id,
          "-",
        ].join(":"),
        requestId = crypto.randomUUID();
      const row = (
        await pool.query(
          `INSERT INTO tender.autopilot_queue(request_id,action_type,tender_id,tender_version_id,company_id,portal_id,credential_id,enrichment_version_id,adapter_id,adapter_version,idempotency_key,reason,status,current_step,created_by,timeout_at,last_progress_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'QUEUED','QUEUED',$13,now()+interval '3 minutes',now()) ON CONFLICT(idempotency_key) WHERE status IN ('PENDING','CLAIMED','RETRY','QUEUED','RUNNING') DO UPDATE SET idempotency_key=excluded.idempotency_key RETURNING *`,
          [
            requestId,
            action,
            target.tender_id,
            target.tender_version_id,
            company.company_id,
            portal.id,
            credential.id,
            target.enrichment_version_id,
            portal.adapter_id,
            portal.adapter_version,
            key,
            `ACTION_${action}_${requestId}`,
            req.identity.userId,
          ],
        )
      ).rows[0];
      await pool.query(
        "INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'autopilot_portal_test_queued',$2,$3::jsonb)",
        [
          req.identity.userId,
          target.tender_id,
          JSON.stringify({
            jobId: row.id,
            actionType: action,
            portalId: portal.id,
            companyId: company.company_id,
            automaticContinuation: action === "TEST_DOCUMENT_FETCH",
            externalWrite: false,
          }),
        ],
      );
      return reply
        .code(row.request_id === requestId ? 202 : 200)
        .send(publicJob(row));
    },
  );
  app.get(
    "/api/management-inbox/autopilot/:tenderId/board-brief",
    { preHandler: requirePermission("tender.board.view") },
    async (req, reply) => {
      const companies = await accessibleCompanies(req.identity),
        company = companies.find(
          (x) => String(x.company_id) === String(req.query?.company || ""),
        );
      if (!company)
        return reply.code(403).send({ error: "company_scope_forbidden" });
      if (!(await requireRegisteredScope(reply, req.params.tenderId, company.company_id))) return;
      const lot = String(req.query?.lot || "") || null,
        version = Number.parseInt(String(req.query?.version || ""), 10) || null;
      if (!version) {
        const canonical = (
          await pool.query(
            "SELECT payload FROM tender.canonical_read_snapshots WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3 AND status='CURRENT' ORDER BY created_at DESC LIMIT 1",
            [req.params.tenderId, company.company_id, lot || ""],
          )
        ).rows[0];
        if (canonical)
          return reply
            .header(
              "content-disposition",
              `attachment; filename=WB-Vorstandsvorlage-${req.params.tenderId}.json`,
            )
            .type("application/json")
            .send({
              ...canonical.payload.boardBrief,
              canonicalSnapshotId: canonical.payload.snapshotId,
              consistencyStatus: canonical.payload.consistencyStatus,
            });
      }
      const row = (
        await pool.query(
          "SELECT board_brief,result_version FROM tender.autopilot_results WHERE tender_id=$1 AND company_id=$2 AND lot_key IS NOT DISTINCT FROM $3 AND ($4::int IS NULL OR result_version=$4) ORDER BY result_version DESC LIMIT 1",
          [req.params.tenderId, company.company_id, lot, version],
        )
      ).rows[0];
      if (!row) return reply.code(404).send({ error: "board_brief_not_found" });
      return reply
        .header("x-read-model-status", "HISTORICAL")
        .header(
          "content-disposition",
          `attachment; filename=WB-Vorstandsvorlage-${req.params.tenderId}.json`,
        )
        .type("application/json")
        .send({ ...row.board_brief, historical: true });
    },
  );
  app.patch(
    "/api/management-inbox/:id",
    { preHandler: [requirePermission("tender.inbox.manage"), csrf] },
    async (req, reply) => {
      const status = String(req.body?.status || "");
      if (
        !["NEW", "REVIEWING", "WAITING", "DECIDED", "ARCHIVED"].includes(status)
      )
        return reply.code(400).send({ error: "status_invalid" });
      const current = (
        await pool.query(
          "SELECT id,tender_id,company_id,sector_slug FROM tender.management_inbox WHERE id=$1",
          [req.params.id],
        )
      ).rows[0];
      if (!current) return reply.code(404).send({ error: "not_found" });
      if (!scoped(req.identity, current))
        return reply.code(403).send({ error: "forbidden" });
      if (!(await requireRegisteredScope(reply, current.tender_id, current.company_id))) return;
      const row = (
        await pool.query(
          `UPDATE tender.management_inbox SET workflow_status=$2,
      responsible_user_id=coalesce($3,responsible_user_id),updated_at=now() WHERE id=$1 RETURNING *`,
          [req.params.id, status, req.body?.responsibleUserId || null],
        )
      ).rows[0];
      if (!row) return reply.code(404).send({ error: "not_found" });
      await pool.query(
        "INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'rc32_inbox_updated',$2,$3)",
        [req.identity.userId, row.tender_id, { inboxId: row.id, status }],
      );
      return row;
    },
  );
  app.get(
    "/api/management-notifications",
    { preHandler: requirePermission("tender.inbox.view") },
    async (req) => {
      const rows = (
        await pool.query(`SELECT n.* FROM tender.management_notifications n
      ORDER BY n.created_at DESC LIMIT 200`)
      ).rows;
      return { items: rows.filter((row) => scoped(req.identity, row)) };
    },
  );
  app.post(
    "/api/management-notifications/:id/ack",
    { preHandler: [requirePermission("tender.notification.manage"), csrf] },
    async (req, reply) => {
      const current = (
        await pool.query(
          "SELECT id,company_id,sector_slug FROM tender.management_notifications WHERE id=$1",
          [req.params.id],
        )
      ).rows[0];
      if (!current) return reply.code(404).send({ error: "not_found" });
      if (!scoped(req.identity, current))
        return reply.code(403).send({ error: "forbidden" });
      const row = (
        await pool.query(
          `UPDATE tender.management_notifications SET acknowledged_by=$2,
      acknowledged_at=now() WHERE id=$1 AND acknowledged_at IS NULL RETURNING *`,
          [req.params.id, req.identity.userId],
        )
      ).rows[0];
      if (!row)
        return reply.code(404).send({ error: "not_found_or_acknowledged" });
      return row;
    },
  );
  app.get(
    "/api/board-briefs/:inboxId",
    { preHandler: requirePermission("tender.board.view") },
    async (req, reply) => {
      const row = (
        await pool.query(
          `SELECT b.*,i.company_id,i.sector_slug FROM tender.board_briefs b
      JOIN tender.management_inbox i ON i.id=b.inbox_id WHERE b.inbox_id=$1`,
          [req.params.inboxId],
        )
      ).rows[0];
      if (!row) return reply.code(404).send({ error: "not_found" });
      if (!scoped(req.identity, row))
        return reply.code(403).send({ error: "forbidden" });
      return row;
    },
  );
  app.get(
    "/api/tenders/:id/versions",
    { preHandler: read },
    async (req, reply) => {
      if (!(await visibleTender(req, reply, req.params.id))) return;
      return {
        items: (
          await pool.query(
            "SELECT id,version,source_sha256,change_kind,source_timestamp,created_at FROM tender.tender_versions WHERE tender_id=$1 ORDER BY version DESC",
            [req.params.id],
          )
        ).rows,
      };
    },
  );
  app.get(
    "/api/tenders/:id/requirements",
    { preHandler: read },
    async (req, reply) => {
      if (!(await visibleTender(req, reply, req.params.id))) return;
      if (!(await requireQueryCompanyScope(req, reply, req.params.id))) return;
      return {
        items: (
          await pool.query(
            "SELECT * FROM tender.requirements WHERE tender_id=$1 ORDER BY due_at NULLS LAST,created_at",
            [req.params.id],
          )
        ).rows,
      };
    },
  );
  app.get(
    "/api/tenders/:id/calculations",
    { preHandler: read },
    async (req, reply) => {
      if (!(await visibleTender(req, reply, req.params.id))) return;
      const registered = await requireQueryCompanyScope(req, reply, req.params.id);
      if (!registered) return;
      return {
        items: (
          await pool.query(
            "SELECT id,version,service_line,scenario,status,blocked_reasons,totals,created_at FROM tender.calculations WHERE tender_id=$1 AND company_id=$2 ORDER BY version DESC,scenario",
            [req.params.id, registered.company_id],
          )
        ).rows,
      };
    },
  );
  app.get(
    "/api/tenders/:id/management-output",
    { preHandler: requirePermission("tender.board.view") },
    async (req, reply) => {
      if (!(await visibleTender(req, reply, req.params.id))) return;
      const companies = await accessibleCompanies(req.identity),
        company = companies.find(
          (row) => String(row.company_id) === String(req.query?.company || ""),
        );
      if (!company)
        return reply.code(403).send({ error: "company_scope_forbidden" });
      if (!(await requireRegisteredScope(reply, req.params.id, company.company_id))) return;
      const lot = String(req.query?.lot || "");
      const row = (
        await pool.query(
          "SELECT id,status,payload,created_at FROM tender.management_outputs WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3 AND historical=false ORDER BY created_at DESC LIMIT 1",
          [req.params.id, company.company_id, lot],
        )
      ).rows[0];
      if (!row)
        return reply.code(404).send({ error: "management_output_not_found" });
      return {
        ...row.payload,
        id: row.id,
        status: row.status,
        createdAt: row.created_at,
        historical: false,
      };
    },
  );
  app.get(
    "/api/tenders/:id/offer-documents",
    { preHandler: read },
    async (req, reply) => {
      if (!(await visibleTender(req, reply, req.params.id))) return;
      const registered = await requireQueryCompanyScope(req, reply, req.params.id);
      if (!registered) return;
      return {
        items: (
          await pool.query(
            "SELECT id,version,format,status,missing_fields,sha256,created_at FROM tender.generated_documents WHERE tender_id=$1 AND company_id=$2 ORDER BY version DESC",
            [req.params.id, registered.company_id],
          )
        ).rows,
      };
    },
  );
  const decisionContext = async (tenderId, companyId, lotKey) => {
    const lot = lotKey || null;
    const [
      tenderVersion,
      calculation,
      management,
      documents,
      queue,
      packages,
      priorApproval,
      portalBinding,
    ] = await Promise.all([
      pool.query(
        "SELECT id,version FROM tender.tender_versions WHERE tender_id=$1 ORDER BY version DESC LIMIT 1",
        [tenderId],
      ),
      pool.query(
        "SELECT id,version,status,blocked_reasons,totals,created_at FROM tender.calculations WHERE tender_id=$1 AND company_id=$2 AND lot_key IS NOT DISTINCT FROM $3 ORDER BY version DESC LIMIT 1",
        [tenderId, companyId, lot],
      ),
      pool.query(
        "SELECT id,status,output_sha256,management_output_version,created_at FROM tender.management_outputs WHERE tender_id=$1 AND company_id=$2 AND lot_key=coalesce($3,'') AND historical=false ORDER BY created_at DESC LIMIT 1",
        [tenderId, companyId, lot],
      ),
      pool.query(
        `SELECT d.id,d.filename,d.payload_sha256,coalesce(d.procurement_verification_status,d.resolution_status,d.fetch_status) status,d.document_class,d.procurement_relevant FROM tender.enrichment_documents d WHERE d.enrichment_version_id=(SELECT id FROM tender.enrichment_versions WHERE tender_id=$1 ORDER BY version DESC LIMIT 1) AND ($2='' OR d.lot_id IS NULL OR EXISTS(SELECT 1 FROM tender.enrichment_lots l WHERE l.id=d.lot_id AND l.lot_key=$2)) ORDER BY d.id`,
        [tenderId, lotKey || ""],
      ),
      pool.query(
        "SELECT portal_id,document_portal,portal_access_status,documents_found,documents_downloaded,documents_analyzed FROM tender.autopilot_queue WHERE tender_id=$1 AND company_id=$2 AND lot_key IS NOT DISTINCT FROM $3 ORDER BY created_at DESC LIMIT 1",
        [tenderId, companyId, lot],
      ),
      pool.query(
        "SELECT id,version,status,missing_items,manifest_sha256,created_at FROM tender.bid_packages WHERE tender_id=$1 AND lot_key=coalesce($2,'') ORDER BY version DESC LIMIT 1",
        [tenderId, lot],
      ),
      pool.query(
        "SELECT id,status,payload_sha256,payload_manifest,created_at,expires_at FROM tender.approval_requests WHERE tender_id=$1 AND calculation_id=(SELECT id FROM tender.calculations WHERE tender_id=$1 AND company_id=$2 AND lot_key IS NOT DISTINCT FROM $3 ORDER BY version DESC LIMIT 1) AND action_type='BID_SUBMISSION' ORDER BY created_at DESC LIMIT 1",
        [tenderId, companyId, lot],
      ),
      pool.query(
        `SELECT a.id portal_adapter_id,p.id portal_id,p.canonical_domain
        FROM tender.enrichment_documents d
        JOIN tender.portal_registry p ON lower(split_part(split_part(d.source_url,'://',2),'/',1))=p.canonical_domain OR lower(split_part(split_part(d.source_url,'://',2),'/',1))=ANY(p.allowed_subdomains)
        JOIN tender.portal_adapters a ON a.portal_code=p.adapter_id
        WHERE d.enrichment_version_id=(SELECT id FROM tender.enrichment_versions WHERE tender_id=$1 ORDER BY version DESC LIMIT 1)
          AND d.procurement_verification_status='VERIFIED'
        ORDER BY d.retrieved_at DESC NULLS LAST,d.id
        LIMIT 1`,
        [tenderId],
      ),
    ]);
    const calc = calculation.rows[0] || null,
      output = management.rows[0] || null,
      job = queue.rows[0] || null,
      offer = packages.rows[0] || null,
      approval = priorApproval.rows[0] || null,
      portal = portalBinding.rows[0] || null;
    const relevantDocuments = documents.rows.filter(
      (row) =>
        row.procurement_relevant !== false &&
        row.document_class !== "GENERAL_PORTAL_DOCUMENT",
    );
    const documentRevision = manifestHash(
      relevantDocuments.map((row) => ({
        id: row.id,
        sha256: row.payload_sha256,
        status: row.status,
      })),
    );
    const bound = approvalBinding({
      tenderId,
      lotKey: lotKey || "GLOBAL",
      companyId,
      portalAdapterId: portal?.portal_adapter_id,
      tenderVersionId: tenderVersion.rows[0]?.id,
      documentVersion: documentRevision,
      calculationId: calc?.id,
      calculationVersion: calc?.version,
      managementOutputId: output?.id,
      managementVersion: output?.management_output_version,
      offerVersion:
        approval?.payload_manifest?.offerVersion ??
        offer?.manifest?.offerVersion ??
        1,
      approverRole: "BOARD_OR_AUTHORIZED_EMPLOYEE",
    });
    const calculated = Boolean(
      calc &&
        ["CALCULATED", "CALCULATION_COMPLETED", "CALCULATED_REAL"].includes(
          calc.status,
        ) &&
        !(calc.blocked_reasons || []).length,
    );
    const managementCurrent = Boolean(
      output &&
        ["MANAGEMENT_OUTPUT_GENERATED", "CALCULATED_REAL"].includes(
          output.status,
        ),
    );
    const documentsVerified =
      relevantDocuments.some((row) => row.status === "VERIFIED") &&
      relevantDocuments.every((row) =>
        [
          "VERIFIED",
          "TENDER_AND_LOT_VERIFIED",
          "TENDER_VERIFIED_LOT_GLOBAL",
          "LOT_ASSOCIATION_MISSING",
          "DOWNLOAD_SUCCEEDED",
          "PROCUREMENT_DOCUMENTS_VERIFIED",
        ].includes(row.status),
      );
    const eligible =
      calculated &&
      managementCurrent &&
      documentsVerified &&
      bound.status === "APPROVAL_BINDING_READY";
    const gate = evaluateSubmissionGate({
      publicReal: true,
      tenderActive: true,
      deadlineOpen: true,
      calculationStatus: calculated ? "CALCULATED" : calc?.status,
      managementOutputCurrent: managementCurrent,
      documentsVerified,
      packageComplete: Boolean(
        offer &&
          offer.status === "BID_PACKAGE_READY_FOR_SUBMISSION" &&
          !(offer.missing_items || []).length,
      ),
      approvalStatus: approval?.status,
      bindingHash: bound.sha256,
      approvalPayloadHash: approval?.payload_sha256,
      portalSessionValid: false,
      mfaComplete: false,
      perActionRelease: false,
      alreadySubmitted: false,
    });
    return {
      eligibleForDecision: eligible,
      calculation: calc,
      managementOutput: output,
      documents: {
        count: relevantDocuments.length,
        verified: documentsVerified,
        revisionSha256: documentRevision,
      },
      portal: {
        id: portal?.portal_id || job?.portal_id || null,
        adapterId: portal?.portal_adapter_id || null,
        name: portal?.canonical_domain || job?.document_portal || null,
        status: job?.portal_access_status || null,
      },
      offerPackage: offer,
      approval,
      binding: bound,
      submissionGate: gate,
      externalActionsEnabled: false,
    };
  };
  app.get(
    "/api/tenders/:id/bid-decision-context",
    { preHandler: requirePermission("tender.board.view") },
    async (req, reply) => {
      if (!(await visibleTender(req, reply, req.params.id))) return;
      const companies = await accessibleCompanies(req.identity),
        company = companies.find(
          (row) => String(row.company_id) === String(req.query?.company || ""),
        );
      if (!company)
        return reply.code(403).send({ error: "company_scope_forbidden" });
      return decisionContext(
        req.params.id,
        company.company_id,
        String(req.query?.lot || ""),
      );
    },
  );
  app.post(
    "/api/tenders/:id/bid-decision",
    { preHandler: [requirePermission("tender.board.approve"), csrf] },
    async (req, reply) => {
      if (!(await visibleTender(req, reply, req.params.id))) return;
      const body = req.body || {},
        companies = await accessibleCompanies(req.identity),
        company = companies.find(
          (row) => String(row.company_id) === String(body.companyId || ""),
        );
      if (!company)
        return reply.code(403).send({ error: "company_scope_forbidden" });
      const action = String(body.action || ""),
        reason = String(body.reason || "")
          .trim()
          .slice(0, 2000),
        context = await decisionContext(
          req.params.id,
          company.company_id,
          String(body.lotKey || ""),
        );
      if (!["APPROVE", "REVISION_REQUESTED", "REJECT"].includes(action))
        return reply.code(400).send({ error: "decision_invalid" });
      if (action !== "APPROVE" && !reason)
        return reply
          .code(400)
          .send({
            error: "reason_required",
            message:
              "Für Änderung oder Ablehnung ist eine Begründung erforderlich.",
          });
      if (action === "APPROVE") {
        if (body.confirmation !== BID_APPROVAL_CONFIRMATION_PHRASE)
          return reply
            .code(409)
            .send({
              error: "explicit_confirmation_required",
              message: "Die verbindliche Bestätigung fehlt.",
            });
        if (!context.eligibleForDecision)
          return reply
            .code(409)
            .send({ error: "calculation_or_evidence_not_eligible", context });
        const expected = context.binding.binding || {},
          submitted = {
            approvalRequestId: String(body.approvalRequestId || ""),
            tenderId: String(body.tenderId || ""),
            lotKey: String(body.lotKey || ""),
            companyId: String(body.companyId || ""),
            documentVersion: String(body.documentVersion || ""),
            calculationVersion: Number(body.calculationVersion),
            managementVersion: Number(body.managementVersion),
            offerVersion: Number(body.offerVersion),
          };
        const deadline = (
            await pool.query(
              "SELECT offer_deadline FROM tender.tenders WHERE id=$1",
              [req.params.id],
            )
          ).rows[0]?.offer_deadline,
          currentApproval = context.approval,
          versionChanged =
            !currentApproval ||
            submitted.approvalRequestId !== String(currentApproval.id) ||
            submitted.tenderId !== String(req.params.id) ||
            submitted.lotKey !==
              String(expected.lotKey === "GLOBAL" ? "" : expected.lotKey) ||
            submitted.companyId !== String(expected.companyId) ||
            submitted.documentVersion !== String(expected.documentVersion) ||
            submitted.calculationVersion !==
              Number(expected.calculationVersion) ||
            submitted.managementVersion !==
              Number(expected.managementVersion) ||
            submitted.offerVersion !== Number(expected.offerVersion);
        if (
          versionChanged ||
          !["REQUESTED", "APPROVED"].includes(currentApproval.status) ||
          (currentApproval.expires_at &&
            new Date(currentApproval.expires_at) <= new Date()) ||
          (deadline && new Date(deadline) <= new Date())
        )
          return reply
            .code(409)
            .send({
              error: "approval_context_changed",
              message:
                "Die Kalkulations- oder Angebotsversion wurde zwischenzeitlich geändert. Bitte prüfen Sie die aktuelle Version erneut.",
            });
      }
      const payload = { ...context.binding.binding, externalExecution: false },
        payloadSha256 = context.binding.sha256,
        status = action === "APPROVE" ? "APPROVED" : action;
      const existing = (
        await pool.query(
          "SELECT id,status FROM tender.approval_requests WHERE tender_id=$1 AND action_type=$2 AND payload_sha256=$3 LIMIT 1",
          [
            req.params.id,
            action === "APPROVE" ? "BID_SUBMISSION" : action,
            payloadSha256,
          ],
        )
      ).rows[0];
      if (existing && existing.status === status && action !== "APPROVE")
        return {
          id: existing.id,
          status: existing.status,
          idempotent: true,
          externalExecution: false,
        };
      if (existing && action === "APPROVE") {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const alreadyApproved = existing.status === "APPROVED",
            updated = alreadyApproved
              ? existing
              : (
                  await client.query(
                    "UPDATE tender.approval_requests SET status='APPROVED' WHERE id=$1 AND status='REQUESTED' AND payload_sha256=$2 AND (expires_at IS NULL OR expires_at>now()) RETURNING id,status",
                    [existing.id, payloadSha256],
                  )
                ).rows[0];
          if (!updated) {
            await client.query("ROLLBACK");
            return reply
              .code(409)
              .send({
                error: "approval_context_changed",
                message:
                  "Die Kalkulations- oder Angebotsversion wurde zwischenzeitlich geändert. Bitte prüfen Sie die aktuelle Version erneut.",
              });
          }
          if (!alreadyApproved)
            await client.query(
              "INSERT INTO tender.approval_events(approval_request_id,actor_id,role_code,decision,reason,payload_sha256) VALUES($1,$2,$3,'APPROVED',NULL,$4)",
              [
                existing.id,
                req.identity.userId,
                (req.identity.roles || [])[0] || "AUTHORIZED_USER",
                payloadSha256,
              ],
            );
          const approvalBinding = approvedPackageBinding({
            tenderId: req.params.id,
            lotKey: body.lotKey || "",
            companyId: company.company_id,
            approvalRequestId: existing.id,
            tenderVersionId: context.binding.binding.tenderVersionId,
            documentVersion: context.binding.binding.documentVersion,
            calculationId: context.binding.binding.calculationId,
            calculationVersion: context.binding.binding.calculationVersion,
            managementOutputId: context.binding.binding.managementOutputId,
            managementVersion: context.binding.binding.managementVersion,
            bidVersion: context.binding.binding.offerVersion,
            portalAdapterId: context.binding.binding.portalAdapterId,
            approvalPayloadHash: payloadSha256,
          });
          const packageManifest = {
              ...context.binding.binding,
              approvalRequestId: existing.id,
              approvalStatus: "APPROVED",
              approvalPayloadHash: payloadSha256,
              externalSubmission: false,
            },
            packageHash = manifestHash(packageManifest),
            packages = (
              await client.query(
                "SELECT * FROM tender.bid_packages WHERE tender_id=$1 AND lot_key=$2 ORDER BY version DESC FOR UPDATE",
                [req.params.id, body.lotKey || ""],
              )
            ).rows,
            resolution = packageResolution(packages, approvalBinding);
          let bidPackage,
            generation,
            packageCreated = false;
          if (resolution.action === "REUSE_EXACT") {
            bidPackage = resolution.package;
            const documents = (
              await client.query(
                "SELECT id,category,version,format,status,sha256,storage_key,output_size_bytes FROM tender.generated_documents WHERE bid_package_id=$1 ORDER BY category",
                [bidPackage.id],
              )
            ).rows;
            generation = {
              bidPackage,
              documents,
              missing: bidPackage.missing_items || [],
              packageComplete:
                bidPackage.status === "BID_PACKAGE_READY_FOR_SUBMISSION" &&
                documents.length === 5 &&
                !(bidPackage.missing_items || []).length,
            };
          } else {
            const staleIds = resolution.supersede.map((pkg) => pkg.id);
            if (staleIds.length) {
              await client.query(
                "UPDATE tender.bid_submission_gates SET status='SUPERSEDED' WHERE bid_package_id=ANY($1::uuid[]) AND status<>'SUPERSEDED'",
                [staleIds],
              );
              await client.query(
                "UPDATE tender.bid_packages SET status='SUPERSEDED',superseded_at=coalesce(superseded_at,now()) WHERE id=ANY($1::uuid[])",
                [staleIds],
              );
            }
            const nextVersion = Number(
              (
                await client.query(
                  "SELECT coalesce(max(version),0)+1 version FROM tender.bid_packages WHERE tender_id=$1 AND lot_key=$2",
                  [req.params.id, body.lotKey || ""],
                )
              ).rows[0].version,
            );
            bidPackage = (
              await client.query(
                `INSERT INTO tender.bid_packages(tender_id,lot_key,portal_adapter_id,tender_version_id,calculation_id,calculation_version,management_output_id,document_revision_sha256,version,status,manifest,manifest_sha256,missing_items,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'GENERATING',$10::jsonb,$11,$12::jsonb,$13) RETURNING *`,
                [
                  req.params.id,
                  body.lotKey || "",
                  context.binding.binding.portalAdapterId,
                  context.binding.binding.tenderVersionId,
                  context.binding.binding.calculationId,
                  context.binding.binding.calculationVersion,
                  context.binding.binding.managementOutputId,
                  context.binding.binding.documentVersion,
                  nextVersion,
                  JSON.stringify(packageManifest),
                  packageHash,
                  JSON.stringify([
                    "PRICE_SHEET",
                    "SPECIFICATION",
                    "FORMS",
                    "EVIDENCE",
                    "CERTIFICATES",
                  ]),
                  req.identity.userId,
                ],
              )
            ).rows[0];
            generation = await generateBidPackageDocuments(client, {
              bidPackageId: bidPackage.id,
              createdBy: req.identity.userId,
            });
            bidPackage = {
              ...generation.bidPackage,
              status: "BID_PACKAGE_VALIDATED",
            };
            packageCreated = true;
          }
          const gate = evaluateSubmissionGate({
            publicReal: true,
            tenderActive: true,
            deadlineOpen: true,
            calculationStatus: "CALCULATED",
            managementOutputCurrent: true,
            documentsVerified: true,
            packageComplete: generation.packageComplete,
            approvalStatus: "APPROVED",
            bindingHash: payloadSha256,
            approvalPayloadHash: payloadSha256,
            portalSessionValid: false,
            mfaComplete: false,
            perActionRelease: false,
            alreadySubmitted: false,
          });
          await client.query(
            "INSERT INTO tender.bid_submission_gates(bid_package_id,approval_request_id,status,reasons,binding_sha256,evaluated_at) VALUES($1,$2,$3,$4::jsonb,$5,now()) ON CONFLICT(bid_package_id,binding_sha256) DO UPDATE SET status=excluded.status,reasons=excluded.reasons,evaluated_at=excluded.evaluated_at",
            [
              bidPackage.id,
              existing.id,
              gate.status,
              JSON.stringify(gate.reasons),
              payloadSha256,
            ],
          );
          await client.query(
            "INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'bid_decision_approved',$2,$3::jsonb),($1,'APPROVAL_GRANTED',$2,$3::jsonb),($1,$6,$2,$4::jsonb),($1,'BID_PACKAGE_VALIDATED',$2,$4::jsonb),($1,'SUBMISSION_GATE_CHECKED',$2,$5::jsonb)",
            [
              req.identity.userId,
              req.params.id,
              JSON.stringify({
                approvalRequestId: existing.id,
                lotKey: body.lotKey || null,
                companyId: company.company_id,
                payloadSha256,
                externalWrite: false,
                idempotent: alreadyApproved,
              }),
              JSON.stringify({
                bidPackageId: bidPackage.id,
                version: bidPackage.version,
                status: bidPackage.status,
                manifestSha256: bidPackage.manifest_sha256,
                documents: generation.documents.map((document) => ({
                  id: document.id,
                  category: document.category,
                  sha256: document.sha256,
                })),
                externalWrite: false,
              }),
              JSON.stringify({
                status: gate.status,
                reasons: gate.reasons,
                transmitted: false,
                externalWrite: false,
              }),
              packageCreated ? "BID_PACKAGE_CREATED" : "BID_PACKAGE_REUSED",
            ],
          );
          await client.query("COMMIT");
          return {
            ...updated,
            idempotent: alreadyApproved && !packageCreated,
            externalExecution: false,
            approvedBy: req.identity.email,
            approvedAt: new Date().toISOString(),
            bidPackage,
            generatedDocuments: generation.documents,
            submissionGate: gate,
            workflow: [
              "APPROVAL_GRANTED",
              packageCreated ? "BID_PACKAGE_CREATED" : "BID_PACKAGE_REUSED",
              ...(packageCreated
                ? ["DOCUMENT_GENERATION_COMPLETED", "PACKAGE_COMPLETE"]
                : []),
              "BID_PACKAGE_VALIDATED",
              "SUBMISSION_GATE_CHECKED",
            ],
          };
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      }
      const current = context.approval;
      if (
        !current ||
        current.status !== "REQUESTED" ||
        current.payload_sha256 !== payloadSha256
      )
        return reply
          .code(409)
          .send({
            error: "approval_context_changed",
            message:
              "Die Kalkulations- oder Angebotsversion wurde zwischenzeitlich geändert. Bitte prüfen Sie die aktuelle Version erneut.",
          });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const request = (
          await client.query(
            "UPDATE tender.approval_requests SET status=$2 WHERE id=$1 AND status='REQUESTED' AND payload_sha256=$3 RETURNING id,status",
            [current.id, status, payloadSha256],
          )
        ).rows[0];
        if (!request) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({
              error: "approval_context_changed",
              message:
                "Die Kalkulations- oder Angebotsversion wurde zwischenzeitlich geändert. Bitte prüfen Sie die aktuelle Version erneut.",
            });
        }
        await client.query(
          "INSERT INTO tender.approval_events(approval_request_id,actor_id,role_code,decision,reason,payload_sha256) VALUES($1,$2,$3,$4,$5,$6)",
          [
            request.id,
            req.identity.userId,
            (req.identity.roles || [])[0] || "AUTHORIZED_USER",
            status,
            reason,
            payloadSha256,
          ],
        );
        await client.query(
          "INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,$2,$3,$4::jsonb)",
          [
            req.identity.userId,
            `bid_decision_${action.toLowerCase()}`,
            req.params.id,
            JSON.stringify({
              approvalRequestId: request.id,
              lotKey: body.lotKey || null,
              companyId: company.company_id,
              payloadSha256,
              externalWrite: false,
            }),
          ],
        );
        await client.query("COMMIT");
        return { ...request, idempotent: false, externalExecution: false };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );
  const submissionPreparation = async (tenderId, companyId, lotKey) => {
    const [calculationResult, managementResult, approvalResult, packageResult] = await Promise.all([
      pool.query("SELECT id,status,blocked_reasons,version FROM tender.calculations WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3 ORDER BY version DESC,created_at DESC LIMIT 1", [tenderId, companyId, lotKey || ""]),
      pool.query("SELECT id,calculation_id,status,management_output_version FROM tender.management_outputs WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3 AND historical=false ORDER BY created_at DESC LIMIT 1", [tenderId, companyId, lotKey || ""]),
      pool.query("SELECT a.id,a.status,a.calculation_id,a.payload_sha256 FROM tender.approval_requests a JOIN tender.calculations c ON c.id=a.calculation_id WHERE c.tender_id=$1 AND c.company_id=$2 AND c.lot_key=$3 AND a.action_type='BID_SUBMISSION' ORDER BY a.created_at DESC LIMIT 1", [tenderId, companyId, lotKey || ""]),
      pool.query(`SELECT package.id,package.status,package.calculation_id,package.management_output_id,package.missing_items,gate.approval_request_id
        FROM tender.bid_packages package JOIN tender.calculations calculation ON calculation.id=package.calculation_id
        LEFT JOIN LATERAL(SELECT approval_request_id FROM tender.bid_submission_gates WHERE bid_package_id=package.id ORDER BY evaluated_at DESC LIMIT 1) gate ON true
        WHERE package.tender_id=$1 AND calculation.company_id=$2 AND package.lot_key=$3 ORDER BY package.version DESC LIMIT 1`, [tenderId, companyId, lotKey || ""]),
    ]);
    const calculation = calculationResult.rows[0] || null,
      management = managementResult.rows[0] || null,
      approval = approvalResult.rows[0] || null,
      bidPackage = packageResult.rows[0] || null,
      calculationReady = Boolean(calculation && ["CALCULATED", "CALCULATION_COMPLETED", "CALCULATED_REAL"].includes(calculation.status) && !(calculation.blocked_reasons || []).length),
      managementOutputCurrent = Boolean(management && String(management.calculation_id) === String(calculation?.id || "") && ["MANAGEMENT_OUTPUT_GENERATED", "CALCULATED_REAL"].includes(management.status)),
      managementApprovalApproved = Boolean(approval && approval.status === "APPROVED" && String(approval.calculation_id) === String(calculation?.id || "")),
      bidPackageValidated = Boolean(bidPackage && bidPackage.status === "BID_PACKAGE_READY_FOR_SUBMISSION" && !(bidPackage.missing_items || []).length && String(bidPackage.calculation_id) === String(calculation?.id || "") && String(bidPackage.management_output_id) === String(management?.id || "") && String(bidPackage.approval_request_id) === String(approval?.id || ""));
    return internalPreparationReadiness({
      calculationReady,
      calculationReason: calculation?.blocked_reasons?.length ? `Es fehlen ${calculation.blocked_reasons.map((item) => item.field || item).join(", ")}.` : undefined,
      managementOutputCurrent,
      managementApprovalApproved,
      bidPackageValidated,
      bidPackageReason: bidPackage?.missing_items?.length ? `Im Angebotspaket fehlen ${bidPackage.missing_items.join(", ")}.` : undefined,
    });
  };
  const submissionRecord = async (tenderId, companyId, lotKey) => {
    const context =
      (
        await pool.query(
          `SELECT context.*,portal.display_name portal_name,portal.canonical_domain,adapter.portal_code,adapter.name adapter_name,portal.adapter_version,tender.canonical_portal_adapter_validation_status(portal.adapter_validation_status) adapter_validation_status,
      approval.status management_approval_status,approval.payload_sha256 approval_payload_sha256,approval.payload_manifest approval_payload_manifest,approval.expires_at approval_expires_at,approval.created_at approval_created_at,approved_event.occurred_at approval_approved_at,
      package.status bid_package_status,package.manifest_sha256 package_hash,package.manifest package_manifest,package.calculation_id package_calculation_id,package.calculation_version package_calculation_version,package.management_output_id package_management_output_id,package.tender_version_id package_tender_version_id,package.document_revision_sha256 package_document_version,approval_gate.approval_request_id package_gate_approval_request_id,approval_gate.binding_sha256 package_gate_binding_sha256,
      credential.id credential_id,credential.id IS NOT NULL credentials_present,coalesce(credential.account_confirmed,false) portal_account_present,(access_grant.id IS NOT NULL AND cap.autopilot_supported=true AND cap.actively_configured=true AND cap.production_tested=true AND cap.browser_acceptance_passed=true AND tender.canonical_portal_adapter_validation_status(portal.adapter_validation_status)='PRODUCTION_VALIDATED') credentials_submission_capable,access_grant.scope submission_grant_scope,access_grant.audit_id submission_grant_audit_id,portal.mfa_required,
      session.status portal_session_status,session.expires_at portal_session_expires_at,session.verification_status portal_session_verification_status,session.session_effective_status portal_session_effective_status,cap.portal_support submission_portal_support,cap.autopilot_supported submission_autopilot_supported,
      receipt.portal_transaction_id,receipt.portal_bid_id,receipt.portal_status receipt_status,receipt.receipt_sha256,receipt.verified_at receipt_verified_at
      FROM tender.submission_contexts context JOIN tender.portal_registry portal ON portal.id=context.portal_id JOIN tender.portal_adapters adapter ON adapter.id=context.portal_adapter_id
      JOIN tender.approval_requests approval ON approval.id=context.approval_request_id JOIN tender.bid_packages package ON package.id=context.bid_package_id
      LEFT JOIN LATERAL(SELECT occurred_at FROM tender.approval_events WHERE approval_request_id=approval.id AND decision='APPROVED' ORDER BY occurred_at DESC LIMIT 1) approved_event ON true
      LEFT JOIN LATERAL(SELECT approval_request_id,binding_sha256 FROM tender.bid_submission_gates WHERE bid_package_id=package.id AND approval_request_id=approval.id ORDER BY evaluated_at DESC LIMIT 1) approval_gate ON true
      LEFT JOIN LATERAL(SELECT credential.* FROM tender.portal_credential_secrets credential JOIN tender.portal_credential_companies company ON company.credential_id=credential.id WHERE credential.portal_id=context.portal_id AND company.company_id=context.company_id AND company.active=true AND credential.status='ACTIVE' ORDER BY credential.version DESC LIMIT 1) credential ON true
      LEFT JOIN LATERAL(SELECT * FROM tender.portal_submission_access_grants WHERE portal_id=context.portal_id AND credential_id=credential.id AND company_id=context.company_id AND status='ACTIVE' ORDER BY granted_at DESC LIMIT 1) access_grant ON true
      LEFT JOIN LATERAL(SELECT status,expires_at,verification_status,tender.portal_session_effective_status(status,expires_at,revoked_at,verification_status) session_effective_status FROM tender.portal_read_sessions WHERE portal_id=context.portal_id AND credential_id=credential.id AND company_id=context.company_id ORDER BY created_at DESC LIMIT 1) session ON true
      LEFT JOIN LATERAL(SELECT feature.portal_support,feature.autopilot_supported,feature.actively_configured,feature.production_tested,feature.browser_acceptance_passed,feature.evidence_note,feature.verified_at FROM tender.portal_capability_profiles profile JOIN tender.portal_capability_features feature ON feature.profile_id=profile.id AND feature.feature_key='SUBMISSION' WHERE profile.portal_id=context.portal_id ORDER BY profile.profile_version DESC LIMIT 1) cap ON true
      LEFT JOIN tender.submission_receipts receipt ON receipt.id=context.receipt_id
      WHERE context.tender_id=$1 AND context.company_id=$2 AND context.lot_key=$3 ORDER BY context.created_at DESC LIMIT 1`,
          [tenderId, companyId, lotKey || ""],
        )
      ).rows[0] || null;
    if (!context) return null;
    const [latestTenderVersion, latestCalculation, latestManagement, currentDocuments] = await Promise.all([
      pool.query("SELECT id,version FROM tender.tender_versions WHERE tender_id=$1 ORDER BY version DESC LIMIT 1", [tenderId]),
      pool.query("SELECT id,version,created_at FROM tender.calculations WHERE tender_id=$1 AND company_id=$2 AND lot_key IS NOT DISTINCT FROM nullif($3,'') ORDER BY version DESC LIMIT 1", [tenderId, companyId, lotKey || ""]),
      pool.query("SELECT id,management_output_version,created_at FROM tender.management_outputs WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3 AND historical=false ORDER BY created_at DESC LIMIT 1", [tenderId, companyId, lotKey || ""]),
      pool.query(`SELECT d.id,d.payload_sha256 sha256,coalesce(d.procurement_verification_status,d.resolution_status,d.fetch_status) status
        FROM tender.enrichment_documents d WHERE d.enrichment_version_id=(SELECT id FROM tender.enrichment_versions WHERE tender_id=$1 ORDER BY version DESC LIMIT 1)
        AND d.procurement_relevant IS DISTINCT FROM false AND d.document_class IS DISTINCT FROM 'GENERAL_PORTAL_DOCUMENT'
        AND ($2='' OR d.lot_id IS NULL OR EXISTS(SELECT 1 FROM tender.enrichment_lots l WHERE l.id=d.lot_id AND l.lot_key=$2)) ORDER BY d.id`, [tenderId, lotKey || ""]),
    ]);
    const calc = latestCalculation.rows[0] || {}, management = latestManagement.rows[0] || {};
    const managementApprovalTruth = evaluateManagementApprovalTruth({
      approval: { id: context.approval_request_id, status: context.management_approval_status, payloadSha256: context.approval_payload_sha256, payloadManifest: context.approval_payload_manifest, expiresAt: context.approval_expires_at, approvedAt: context.approval_approved_at || context.approval_created_at },
      context,
      bidPackage: { id: context.bid_package_id, tender_version_id: context.package_tender_version_id, document_revision_sha256: context.package_document_version, calculation_id: context.package_calculation_id, calculation_version: context.package_calculation_version, management_output_id: context.package_management_output_id, manifest: context.package_manifest, approvalGate: { approvalRequestId: context.package_gate_approval_request_id, bindingSha256: context.package_gate_binding_sha256 } },
      current: { tenderVersionId: latestTenderVersion.rows[0]?.id || null, documentVersion: currentDocuments.rows.length ? manifestHash(currentDocuments.rows) : null, calculationId: calc.id || null, calculationVersion: calc.version ?? null, calculationChangedAt: calc.created_at || null, managementOutputId: management.id || null, managementVersion: management.management_output_version ?? null, managementChangedAt: management.created_at || null },
    });
    const [mappings, preflight, transitions] = await Promise.all([
      pool.query(
        "SELECT category,filename,format,size_bytes,sha256,required,portal_target,upload_status,uploaded_at FROM tender.submission_document_mappings WHERE submission_context_id=$1 ORDER BY category",
        [context.id],
      ),
      pool.query(
        "SELECT check_version,status,checks,blockers,portal_validation,checked_at FROM tender.submission_preflight_checks WHERE submission_context_id=$1 ORDER BY check_version DESC LIMIT 1",
        [context.id],
      ),
      pool.query(
        "SELECT from_status,to_status,reason,result,occurred_at FROM tender.submission_state_transitions WHERE submission_context_id=$1 ORDER BY occurred_at",
        [context.id],
      ),
    ]);
    let rawBlockers = preflight.rows[0]?.blockers || context.blockers || [];
    rawBlockers = rawBlockers.filter((blocker) => blocker?.code !== "MANAGEMENT_APPROVAL_INVALID");
    const approvalBlocker = managementApprovalBlocker(managementApprovalTruth);
    if (approvalBlocker) rawBlockers.unshift(approvalBlocker);
    rawBlockers = rawBlockers.map((blocker) => blocker?.code === "AUTOPILOT_SUBMISSION_NOT_IMPLEMENTED" ? { ...blocker, message: `Der Submission-Adapter ${context.adapter_name} (${context.portal_code}, Version ${context.adapter_version || "unbekannt"}) ist für externe Angebotsabgaben nicht produktiv validiert. Intern fehlen eine aktiv konfigurierte, produktiv getestete und browserabgenommene SUBMISSION-Fähigkeit sowie der validierte Schreib- und Receipt-Pfad.` } : blocker);
    const portalScope = { portalId: context.portal_id, credentialId: context.credential_id || null, companyId, tenderId, lotKey: lotKey || "" },
      requirementIds = [...new Set(rawBlockers.map((blocker) => String(blocker?.requiredDocumentId || "")).filter(validUuid))],
      exactSources = new Map(),
      supersededRequirementIds = new Set();
    if (requirementIds.length) {
      const sourceRows = (await pool.query(`SELECT r.id required_document_id,r.satisfaction_status,r.source_document_id,d.id document_id,d.filename,d.mime_type,d.payload_sha256,d.content,r.source_page,v.version document_version,v.tender_id source_tender_id
        FROM tender.required_documents r
        LEFT JOIN tender.enrichment_documents d ON d.id=r.source_document_id
        LEFT JOIN tender.enrichment_versions v ON v.id=d.enrichment_version_id AND v.tender_id=r.tender_id
        WHERE r.id=ANY($1::uuid[]) AND r.tender_id=$2 AND r.company_id=$3 AND r.lot_key=$4`,
        [requirementIds,tenderId,companyId,lotKey || ""])).rows;
      for (const row of sourceRows) {
        if (row.satisfaction_status === "SUPERSEDED") { supersededRequirementIds.add(String(row.required_document_id)); continue; }
        if (!row.document_id) continue;
        const source = resolveRequiredSourceDocument({id:row.required_document_id,tender_id:tenderId,company_id:companyId,lot_key:lotKey || "",source_document_id:row.source_document_id,source_page:row.source_page,satisfaction_status:"MISSING"},[{id:row.document_id,tender_id:row.source_tender_id,required_document_id:row.required_document_id,company_id:companyId,lot_key:lotKey || "",filename:row.filename,mime_type:row.mime_type,payload_sha256:row.payload_sha256,content:row.content,document_version:row.document_version}]);
        if (source.available) exactSources.set(String(row.required_document_id),{available:true,requiredDocumentId:row.required_document_id,documentId:source.documentId,page:source.page,mimeType:source.mimeType});
      }
    }
    const decoratedBlockers = decorateSubmissionBlockers(rawBlockers.filter((blocker)=>!supersededRequirementIds.has(String(blocker?.requiredDocumentId||""))), exactSources, portalScope),
      latestPreflight = preflight.rows[0] ? {...preflight.rows[0],blockers:decoratedBlockers} : null;
    return {
      ...context,
      management_approval_valid: managementApprovalTruth.valid,
      management_approval_truth: managementApprovalTruth,
      blockers: decoratedBlockers,
      mappings: mappings.rows,
      latestPreflight,
      transitions: transitions.rows,
    };
  };
  app.get(
    "/api/tenders/:id/submission-context",
    { preHandler: requirePermission("tender.board.view") },
    async (req, reply) => {
      if (!(await visibleTender(req, reply, req.params.id))) return;
      const companyId = String(req.query?.company || ""),
        companies = await accessibleCompanies(req.identity);
      if (
        !companies.some((company) => String(company.company_id) === companyId)
      )
        return reply.code(403).send({ error: "company_scope_forbidden" });
      if (!(await requireRegisteredScope(reply, req.params.id, companyId))) return;
      const context = await submissionRecord(
        req.params.id,
        companyId,
        String(req.query?.lot || ""),
      );
      return context
        ? { ...context, exists: true, preparation: await submissionPreparation(req.params.id, companyId, String(req.query?.lot || "")) }
        : {
            exists: false,
            message: "Die interne Vorbereitung der Angebotsabgabe wurde noch nicht angelegt.",
            preparation: await submissionPreparation(req.params.id, companyId, String(req.query?.lot || "")),
            externalSubmission: false,
            transmitted: false,
          };
    },
  );
  app.post(
    "/api/tenders/:id/submission-context",
    { preHandler: [requirePermission("tender.submission.prepare"), csrf] },
    async (req, reply) => {
      if (!(await visibleTender(req, reply, req.params.id))) return;
      const companyId = String(req.body?.companyId || ""),
        lotKey = String(req.body?.lotKey || ""),
        companies = await accessibleCompanies(req.identity);
      if (
        !companies.some((company) => String(company.company_id) === companyId)
      )
        return reply.code(403).send({ error: "company_scope_forbidden" });
      if (!(await requireRegisteredScope(reply, req.params.id, companyId))) return;
      const existing = await submissionRecord(req.params.id, companyId, lotKey);
      const preparation = await submissionPreparation(req.params.id, companyId, lotKey);
      if (!existing && !preparation.ready)
        return reply.code(409).send({ error: "internal_preparation_prerequisites_missing", message: "Die interne Vorbereitung kann erst nach Abschluss aller Voraussetzungen angelegt werden.", preparation, externalSubmission: false, transmitted: false });
      const source = (
        await pool.query(
          `SELECT package.*,calculation.company_id,management.management_output_version,tender.offer_deadline,approval.id approval_request_id,approval.status approval_status,approval.payload_sha256,portal.id portal_id,portal.adapter_id portal_code,cap.portal_support,cap.autopilot_supported,
      credential.id credential_id,credential.account_confirmed,access_grant.id submission_grant_id,access_grant.scope submission_grant_scope,session.id portal_session_id,session.status session_status,session.expires_at session_expires_at,session.verification_status session_verification_status,session.session_effective_status
      FROM tender.bid_packages package JOIN tender.calculations calculation ON calculation.id=package.calculation_id JOIN tender.management_outputs management ON management.id=package.management_output_id JOIN tender.tenders tender ON tender.id=package.tender_id
      JOIN tender.bid_submission_gates gate ON gate.bid_package_id=package.id JOIN tender.approval_requests approval ON approval.id=gate.approval_request_id JOIN tender.portal_adapters adapter ON adapter.id=package.portal_adapter_id JOIN tender.portal_registry portal ON portal.adapter_id=adapter.portal_code
      LEFT JOIN LATERAL(SELECT feature.portal_support,feature.autopilot_supported FROM tender.portal_capability_profiles profile JOIN tender.portal_capability_features feature ON feature.profile_id=profile.id AND feature.feature_key='SUBMISSION' WHERE profile.portal_id=portal.id) cap ON true
      LEFT JOIN LATERAL(SELECT credential.* FROM tender.portal_credential_secrets credential JOIN tender.portal_credential_companies company ON company.credential_id=credential.id WHERE credential.portal_id=portal.id AND company.company_id=calculation.company_id AND company.active=true AND credential.status='ACTIVE' ORDER BY credential.version DESC LIMIT 1) credential ON true
      LEFT JOIN LATERAL(SELECT * FROM tender.portal_submission_access_grants access_grant WHERE access_grant.portal_id=portal.id AND access_grant.credential_id=credential.id AND access_grant.company_id=calculation.company_id AND access_grant.status='ACTIVE' ORDER BY access_grant.granted_at DESC LIMIT 1) access_grant ON true
      LEFT JOIN LATERAL(SELECT session.*,tender.portal_session_effective_status(session.status,session.expires_at,session.revoked_at,session.verification_status) session_effective_status FROM tender.portal_read_sessions session WHERE session.portal_id=portal.id AND session.credential_id=credential.id AND session.company_id=calculation.company_id ORDER BY session.created_at DESC LIMIT 1) session ON true
      WHERE package.tender_id=$1 AND calculation.company_id=$2 AND package.lot_key=$3 AND package.status='BID_PACKAGE_READY_FOR_SUBMISSION' AND approval.status='APPROVED' ORDER BY package.version DESC,gate.evaluated_at DESC LIMIT 1`,
          [req.params.id, companyId, lotKey],
        )
      ).rows[0];
      if (!source)
        return reply
          .code(409)
          .send({
            error: "approved_bid_package_required",
            message: "Ein gültig freigegebenes kanonisches Bid Package fehlt.",
          });
      if (source.approval_status !== "APPROVED")
        return reply
          .code(409)
          .send({
            error: "management_approval_required",
            message: "Die versionsgebundene Managementfreigabe fehlt.",
          });
      if (existing && String(existing.bid_package_id) === String(source.id))
        return { ...existing, idempotent: true };
      const adapter = submissionAdapters[source.portal_code],
        sessionValid = source.session_effective_status === "ACTIVE",
        status =
          source.portal_support !== "SUPPORTED"
            ? "NOT_READY"
            : !source.account_confirmed
              ? "WAITING_FOR_PORTAL_ACCOUNT"
              : !source.credential_id || !source.submission_grant_id
                ? "WAITING_FOR_CREDENTIALS"
                : !source.autopilot_supported || !adapter?.productionValidated
                  ? "NOT_READY"
                  : !sessionValid
                    ? "WAITING_FOR_SESSION"
                    : "SESSION_READY";
      const binding = {
          tenderId: req.params.id,
          lotKey,
          companyId,
          portalId: source.portal_id,
          portalAdapterId: source.portal_adapter_id,
          approvalRequestId: source.approval_request_id,
          bidPackageId: source.id,
          bidPackageVersion: source.version,
          documentVersion: source.document_revision_sha256,
          calculationVersion: source.calculation_version,
          managementVersion: source.management_output_version,
          bidVersion: source.version,
          deadline: source.offer_deadline,
        },
        fingerprint = submissionFingerprint(binding),
        auditId = `SUB-${fingerprint.slice(0, 32)}`,
        client = await pool.connect();
      try {
        await client.query("BEGIN");
        const saved = (
          await client.query(
            `INSERT INTO tender.submission_contexts(tender_id,lot_key,company_id,portal_id,portal_adapter_id,approval_request_id,bid_package_id,bid_package_version,document_version,calculation_version,management_version,bid_version,deadline,portal_session_id,submission_status,binding_sha256,idempotency_key,audit_id,blockers,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20) ON CONFLICT(bid_package_id,binding_sha256) DO UPDATE SET updated_at=now() RETURNING *`,
            [
              req.params.id,
              lotKey,
              companyId,
              source.portal_id,
              source.portal_adapter_id,
              source.approval_request_id,
              source.id,
              source.version,
              source.document_revision_sha256,
              source.calculation_version,
              source.management_output_version,
              source.version,
              source.offer_deadline,
              sessionValid ? source.portal_session_id : null,
              status,
              fingerprint,
              submissionHash({ fingerprint, action: "BID_SUBMISSION" }),
              auditId,
              JSON.stringify(
                status === "NOT_READY"
                  ? [
                      {
                        code: "AUTOPILOT_SUBMISSION_NOT_IMPLEMENTED",
                        message:
                          "Der Submission-Adapter ist noch nicht produktiv validiert.",
                      },
                    ]
                  : [],
              ),
              req.identity.userId,
            ],
          )
        ).rows[0];
        await client.query(
          "INSERT INTO tender.submission_state_transitions(submission_context_id,from_status,to_status,actor_id,reason,binding_sha256,idempotency_key) VALUES($1,NULL,$2,$3,'SUBMISSION_CONTEXT_CREATED',$4,$5) ON CONFLICT(idempotency_key) DO NOTHING",
          [
            saved.id,
            status,
            req.identity.userId,
            fingerprint,
            submissionHash({
              context: saved.id,
              to: status,
              binding: fingerprint,
            }),
          ],
        );
        await client.query(
          "INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'SUBMISSION_CONTEXT_CREATED',$2,$3::jsonb)",
          [
            req.identity.userId,
            req.params.id,
            JSON.stringify({
              submissionContextId: saved.id,
              bidPackageId: source.id,
              approvalRequestId: source.approval_request_id,
              bindingSha256: fingerprint,
              status,
              externalWrite: false,
            }),
          ],
        );
        await client.query("COMMIT");
        return reply
          .code(201)
          .send({
            ...(await submissionRecord(req.params.id, companyId, lotKey)),
            idempotent: false,
          });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );
  app.post(
    "/api/tenders/:id/submission-preflight",
    { preHandler: [requirePermission("tender.submission.prepare"), csrf] },
    async (req, reply) => {
      if (!(await visibleTender(req, reply, req.params.id))) return;
      const companyId = String(req.body?.companyId || ""),
        lotKey = String(req.body?.lotKey || "");
      if (!(await requireRegisteredScope(reply, req.params.id, companyId))) return;
      const context = await submissionRecord(req.params.id, companyId, lotKey);
      if (!context)
        return reply
          .code(409)
          .send({
            error: "submission_context_required",
            message:
              "Zuerst muss der kanonische Abgabekontext angelegt werden.",
          });
      const technicalSessionValid = context.portal_session_effective_status === "ACTIVE",
        eligibility = (
          await pool.query(
            "SELECT * FROM tender.current_portal_company_eligibility WHERE portal_id=$1 AND company_id=$2",
            [context.portal_id, companyId],
          )
        ).rows[0],
        bidderIdentityValid = [
          "SUBMISSION_READY",
          "MULTI_COMPANY_SELECTION_AVAILABLE",
          "SUBMISSION_PERMISSION_REQUIRED",
        ].includes(eligibility?.eligibility_status),
        documents = (
          await pool.query(
            "SELECT category,sha256,status,format,output_size_bytes FROM tender.generated_documents WHERE bid_package_id=$1 ORDER BY category",
            [context.bid_package_id],
          )
        ).rows,
        requiredDocuments = await requiredDocumentContext(req.params.id,companyId,lotKey),
        requiredDocumentGatePassed = submissionDocumentsComplete(requiredDocuments),
        genericReadiness = (await pool.query(`SELECT c.id,c.readiness_status,c.binding_valid,coalesce(jsonb_agg(jsonb_build_object('id',r.id,'requirementKey',r.requirement_key,'code',r.requirement_kind,'title',r.title,'status',r.status,'source',r.source_reference,'page',r.source_page,'sourceDocumentId',r.source_document_id)) FILTER(WHERE r.id IS NOT NULL AND r.submission_relevant AND r.mandatory AND r.status NOT IN('VALIDATED','NOT_REQUIRED','SUPERSEDED')),'[]'::jsonb) open_requirements
          FROM tender.final_preflight_contexts c LEFT JOIN tender.final_preflight_requirements r ON r.context_id=c.id
          WHERE c.tender_id=$1 AND c.company_id=$2 AND c.lot_key=$3 AND c.is_current GROUP BY c.id`,[req.params.id,companyId,lotKey])).rows[0],
        preflight = evaluateEnterprisePreflight({
          managementApprovalValid: context.management_approval_valid === true,
          bidPackageReady:
            context.bid_package_status === "BID_PACKAGE_READY_FOR_SUBMISSION",
          portalSupportsSubmission:
            context.submission_portal_support === "SUPPORTED",
          autopilotSupportsSubmission:
            context.submission_autopilot_supported === true &&
            submissionAdapters[context.portal_code]?.productionValidated ===
              true,
          portalAccountPresent: context.portal_account_present === true,
          credentialsPresent: context.credentials_present === true,
          credentialsSubmissionCapable:
            context.credentials_submission_capable === true,
          portalSessionValid: bidderIdentityValid
            ? technicalSessionValid
            : true,
          mfaComplete: !context.mfa_required,
          targetResolved: bidderIdentityValid,
          deadlineOpen: new Date(context.deadline) > new Date(),
          packageMapped: false,
          requiredDocumentsComplete:
            documents.length >= 5 &&
            documents.every((document) => document.status === "GENERATED") &&
            requiredDocumentGatePassed,
          formatsAccepted: false,
          sizesAccepted: false,
          requiredFieldsComplete: false,
          signatureSatisfied: false,
          amendmentsChecked: false,
          versionBindingValid:
            submissionFingerprint(context) === context.binding_sha256,
          portalValidationPassed: false,
        });
      if(!requiredDocumentGatePassed){
        preflight.blockers=preflight.blockers.filter(x=>x.code!=="REQUIRED_DOCUMENTS_INCOMPLETE");
        for(const requirement of requiredDocuments.filter(x=>x.mandatory&&x.submission_relevant&&!["VALIDATED","NOT_REQUIRED","SUPERSEDED"].includes(x.satisfaction_status)))
          preflight.blockers.push({code:"REQUIRED_DOCUMENT_INCOMPLETE",requiredDocumentId:requirement.id,message:`${requirement.requirement_title}: ${requirement.status_label}.`});
        preflight.status="PREFLIGHT_BLOCKED";
      }
      if(!genericReadiness || genericReadiness.readiness_status!=="PREFLIGHT_READY"){
        for(const requirement of genericReadiness?.open_requirements||[]){
          const exactRequiredDocument = requiredDocuments.find((item)=>String(item.requirement_code||"")===String(requirement.requirementKey||"")&&String(item.source_document_id||"")===String(requirement.sourceDocumentId||""));
          preflight.blockers.push({code:`FINAL_PREFLIGHT_${requirement.code}`,genericRequirementId:requirement.id,requiredDocumentId:exactRequiredDocument?.id||undefined,sourceDocumentId:requirement.sourceDocumentId||undefined,message:`${requirement.title} (${requirement.source}${requirement.page?`, Seite ${requirement.page}`:""}).`});
        }
        if(!genericReadiness) preflight.blockers.push({code:"FINAL_PREFLIGHT_DISCOVERY_REQUIRED",message:"Die tenderindividuelle Final-Preflight-Ermittlung ist noch nicht abgeschlossen."});
        else if(!genericReadiness.binding_valid) preflight.blockers.push({code:"CURRENT_CONTEXT_BINDING_INVALID",message:"Tender, Kalkulation, Management, Approval, Bid Package und Submission Context sind nicht durchgängig aktuell gebunden."});
        preflight.status="PREFLIGHT_BLOCKED";
      }
      if (!bidderIdentityValid) {
        const unresolved = preflight.blockers.findIndex(
          (blocker) => blocker.code === "SUBMISSION_TARGET_UNRESOLVED",
        );
        const identityBlocker = {
          code: eligibility?.eligibility_status || "NOT_AUTHORITATIV_VERIFIED",
          message:
            eligibility?.eligibility_status === "ACCOUNT_FOR_OTHER_COMPANY"
              ? `Der vorhandene Portalaccount ist auf ${eligibility.account_holder_name || "eine andere Gesellschaft"} gebunden und kann nicht für ${eligibility.company_name} verwendet werden.`
              : eligibility?.eligibility_status === "REGISTRATION_REQUIRED"
                ? `Für ${eligibility.company_name} ist ein geeigneter Bieterzugang erforderlich.`
                : "Die rechtliche Bieteridentität ist für diese Gesellschaft noch nicht autoritativ bestätigt.",
        };
        if (unresolved >= 0)
          preflight.blockers.splice(unresolved, 1, identityBlocker);
        else preflight.blockers.push(identityBlocker);
        preflight.status = "PREFLIGHT_BLOCKED";
      }
      const version = Number(
          (
            await pool.query(
              "SELECT coalesce(max(check_version),0)+1 version FROM tender.submission_preflight_checks WHERE submission_context_id=$1",
              [context.id],
            )
          ).rows[0].version,
        );
      await pool.query(
        "INSERT INTO tender.submission_preflight_checks(submission_context_id,check_version,status,checks,blockers,portal_validation,binding_sha256,checked_by) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8)",
        [
          context.id,
          version,
          preflight.status,
          JSON.stringify({
            documents: documents.length,
            requiredDocuments: requiredDocuments.length,
            requiredDocumentsComplete: requiredDocumentGatePassed,
            genericFinalPreflightStatus: genericReadiness?.readiness_status||"DISCOVERY_PENDING",
            technicalSessionValid,
            bidderIdentityValid,
            portalAccountCompany: eligibility?.account_holder_name || null,
            submissionBidderCompany: eligibility?.company_name || null,
            eligibilityStatus:
              eligibility?.eligibility_status || "NOT_AUTHORITATIV_VERIFIED",
            deadlineOpen: new Date(context.deadline) > new Date(),
            externalWrite: false,
            externalSubmissionEnabled: false,
            transmitted: false,
          }),
          JSON.stringify(preflight.blockers),
          JSON.stringify({
            status: "NOT_RUN",
            reason:
              "Submission-Adapter oder schreibberechtigtes Konto nicht produktiv freigegeben",
          }),
          context.binding_sha256,
          req.identity.userId,
        ],
      );
      await pool.query(
        "UPDATE tender.submission_contexts SET preflight_status=$2,blockers=$3::jsonb,updated_at=now() WHERE id=$1",
        [context.id, preflight.status, JSON.stringify(preflight.blockers)],
      );
      await pool.query(
        "INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'SUBMISSION_PREFLIGHT_CHECKED',$2,$3::jsonb)",
        [
          req.identity.userId,
          req.params.id,
          JSON.stringify({
            submissionContextId: context.id,
            status: preflight.status,
            blockers: preflight.blockers.map((blocker) => blocker.code),
            externalWrite: false,
            externalSubmissionEnabled: false,
            transmitted: false,
          }),
        ],
      );
      return {
        ...preflight,
        submissionContextId: context.id,
        portalValidationStatus: "NOT_RUN",
        externalWrite: false,
        external_submission_enabled: false,
        transmitted: false,
      };
    },
  );
  app.post(
    "/api/tenders/:id/submission",
    { preHandler: [requirePermission("tender.submission.approve"), csrf] },
    async (req, reply) =>
      reply
        .code(423)
        .send({
          error: "final_submission_not_released",
          message:
            "Die externe Übermittlung ist nicht freigegeben. Es wurde nichts übermittelt.",
          external_submission_enabled: false,
          transmitted: false,
        }),
  );
  app.get(
    "/api/tenders/:id/submission-feedback",
    { preHandler: requirePermission("tender.board.view") },
    async (req, reply) => {
      if (!(await visibleTender(req, reply, req.params.id))) return;
      const companyId=String(req.query?.company||""),lotKey=String(req.query?.lot||""),companies=await accessibleCompanies(req.identity);
      if(!companies.some(company=>String(company.company_id)===companyId))return reply.code(403).send({error:"company_scope_forbidden"});
      if(!(await requireRegisteredScope(reply,req.params.id,companyId)))return;
      const context=(await pool.query("SELECT id FROM tender.submission_contexts WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3 ORDER BY created_at DESC LIMIT 1",[req.params.id,companyId,lotKey])).rows[0];
      if(!context)return {items:[],jobs:[],status:"NOT_STARTED",external_submission_enabled:false,transmitted:false};
      const [events,jobs,manifests]=await Promise.all([
        pool.query(`SELECT id,event_type,external_event_id,source_mode,payload,event_sha256,observed_at,received_at FROM tender.portal_inbound_events WHERE submission_context_id=$1 ORDER BY observed_at DESC,received_at DESC LIMIT 200`,[context.id]),
        pool.query(`SELECT id,job_kind,status,attempt,max_attempts,next_attempt_at,last_error_class,last_error_safe,updated_at FROM tender.submission_reconciliation_jobs WHERE submission_context_id=$1 ORDER BY created_at DESC LIMIT 50`,[context.id]),
        pool.query(`SELECT id,manifest_version,manifest_sha256,approval_request_id,binding_sha256,created_at FROM tender.submission_package_manifests WHERE submission_context_id=$1 ORDER BY manifest_version DESC`,[context.id]),
      ]);
      return {submissionContextId:context.id,items:events.rows.map(event=>({...event,display:monitoringEventPresentation(event)})),jobs:jobs.rows,manifests:manifests.rows,status:events.rows[0]?.event_type||"MONITORING_READY",external_submission_enabled:false,transmitted:false};
    },
  );
  app.post(
    "/api/tenders/:id/submission-package-manifest",
    { preHandler:[requirePermission("tender.submission.prepare"),csrf] },
    async(req,reply)=>{
      if(!(await visibleTender(req,reply,req.params.id)))return;
      const companyId=String(req.body?.companyId||""),lotKey=String(req.body?.lotKey||""),companies=await accessibleCompanies(req.identity);
      if(!companies.some(company=>String(company.company_id)===companyId))return reply.code(403).send({error:"company_scope_forbidden"});
      if(!(await requireRegisteredScope(reply,req.params.id,companyId)))return;
      const context=await submissionRecord(req.params.id,companyId,lotKey);
      if(!context)return reply.code(409).send({error:"submission_context_required",message:"Zuerst muss der kanonische Abgabekontext angelegt werden."});
      const documents=(await pool.query("SELECT id,category,category||'.'||lower(format) filename,output_media_type media_type,output_size_bytes size_bytes,sha256,version FROM tender.generated_documents WHERE bid_package_id=$1 AND status='INTERNAL_DRAFT_READY' ORDER BY category,version",[context.bid_package_id])).rows;
      let manifest;
      try{manifest=canonicalPackageManifest({scope:{tenderId:req.params.id,companyId,lotKey,portalId:context.portal_id,credentialId:context.credential_id},approval:{id:context.approval_request_id,payloadSha256:context.approval_payload_sha256,approvedVersion:context.management_version},documents:documents.map(document=>({id:document.id,category:document.category,filename:document.filename,mediaType:document.media_type,sizeBytes:Number(document.size_bytes),sha256:document.sha256,version:document.version})),createdAt:context.created_at});}
      catch(error){return reply.code(422).send({error:error.code||"package_manifest_invalid",message:"Das unveränderliche Paketmanifest konnte aus dem aktuellen, freigegebenen Stand nicht gebildet werden."})}
      const client=await pool.connect();let saved,item;
      try{await client.query("BEGIN");await client.query("SELECT id FROM tender.submission_contexts WHERE id=$1 FOR UPDATE",[context.id]);const existing=(await client.query("SELECT id,manifest_version,manifest_sha256,created_at FROM tender.submission_package_manifests WHERE submission_context_id=$1 AND manifest_sha256=$2",[context.id,manifest.manifestSha256])).rows[0];if(existing){item=existing}else{const version=Number((await client.query("SELECT coalesce(max(manifest_version),0)+1 version FROM tender.submission_package_manifests WHERE submission_context_id=$1",[context.id])).rows[0].version);saved=(await client.query(`INSERT INTO tender.submission_package_manifests(submission_context_id,manifest_version,manifest,manifest_sha256,approval_request_id,binding_sha256,created_by) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7) RETURNING id,manifest_version,manifest_sha256,created_at`,[context.id,version,JSON.stringify(manifest),manifest.manifestSha256,context.approval_request_id,context.binding_sha256,req.identity.userId])).rows[0];item=saved}await client.query("COMMIT")}catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
      return reply.code(saved?201:200).send({...item,idempotent:!saved,immutable:true,external_submission_enabled:false,transmitted:false});
    },
  );
  app.get(
    "/api/tenders/:id/binding-action-releases",
    { preHandler: requirePermission("tender.board.view") },
    async(req,reply)=>{
      if(!(await visibleTender(req,reply,req.params.id)))return;
      const companyId=String(req.query?.company||""),lotKey=String(req.query?.lot||""),companies=await accessibleCompanies(req.identity);
      if(!companies.some(company=>String(company.company_id)===companyId))return reply.code(403).send({error:"company_scope_forbidden"});
      if(!(await requireRegisteredScope(reply,req.params.id,companyId)))return;
      const rows=(await pool.query(`SELECT release.*,latest.manifest_sha256 latest_package_hash,approval.status management_approval_status,
        (approval.expires_at IS NULL OR approval.expires_at>now()) management_approval_unexpired,
        coalesce(jsonb_agg(jsonb_build_object('eventType',event.event_type,'actorId',event.actor_id,'occurredAt',event.occurred_at)) FILTER(WHERE event.id IS NOT NULL),'[]'::jsonb) events
        FROM tender.binding_action_releases release
        JOIN tender.approval_requests approval ON approval.id=release.management_approval_request_id
        LEFT JOIN LATERAL(SELECT manifest_sha256 FROM tender.submission_package_manifests WHERE submission_context_id=release.submission_context_id ORDER BY manifest_version DESC LIMIT 1)latest ON true
        LEFT JOIN tender.binding_action_release_events event ON event.release_id=release.id
        WHERE release.tender_id=$1 AND release.company_id=$2 AND release.lot_key=$3
        GROUP BY release.id,latest.manifest_sha256,approval.status,approval.expires_at ORDER BY release.requested_at DESC LIMIT 50`,[req.params.id,companyId,lotKey])).rows;
      const items=rows.map(row=>{
        const scope={companyId:row.company_id,credentialId:row.credential_id,portalId:row.portal_id,tenderId:row.tender_id,lotKey:row.lot_key,bidPackageHash:row.bid_package_hash,managementApprovalId:row.management_approval_request_id};
        const current={scope:{...scope,bidPackageHash:row.latest_package_hash||""}};
        const state=effectiveBindingRelease({status:row.status,scope,expiresAt:row.expires_at,requestedBy:row.requested_by,approvedBy:row.approved_by,managementApprovalValid:row.management_approval_status==="APPROVED"&&row.management_approval_unexpired},current);
        return {id:row.id,status:state.status,reason:state.reason,valid:state.valid,scope,bindingSha256:row.binding_sha256,requestedBy:row.requested_by,approvedBy:row.approved_by,requestedAt:row.requested_at,approvedAt:row.approved_at,expiresAt:row.expires_at,events:row.events,internalFinalizationOnly:true,external_submission_enabled:false,transmitted:false};
      });
      return {items,denyByDefault:true,bindingExecutionAllowed:false,bindingEndpointsHttpStatus:423,external_submission_enabled:false,transmitted:false};
    },
  );
  app.post(
    "/api/tenders/:id/binding-action-releases",
    { preHandler:[requirePermission("tender.submission.prepare"),csrf] },
    async(req,reply)=>{
      if(!(await visibleTender(req,reply,req.params.id)))return;
      const companyId=String(req.body?.companyId||""),lotKey=String(req.body?.lotKey||""),companies=await accessibleCompanies(req.identity);
      if(!companies.some(company=>String(company.company_id)===companyId))return reply.code(403).send({error:"company_scope_forbidden"});
      if(!(await requireRegisteredScope(reply,req.params.id,companyId)))return;
      const context=await submissionRecord(req.params.id,companyId,lotKey);
      if(!context)return reply.code(409).send({error:"submission_context_required",message:"Zuerst muss die interne Angebotsvorbereitung angelegt werden."});
      if(!context.credential_id)return reply.code(409).send({error:"portal_credential_required",message:"Für diesen Gesellschafts- und Portalkontext fehlt ein aktiver Zugang."});
      if(context.management_approval_valid!==true)return reply.code(409).send({error:"management_approval_invalid",message:"Die aktuelle Kalkulations- und Angebotsversion benötigt eine gültige Managementfreigabe."});
      const manifest=(await pool.query("SELECT manifest_sha256 FROM tender.submission_package_manifests WHERE submission_context_id=$1 ORDER BY manifest_version DESC LIMIT 1",[context.id])).rows[0];
      if(!manifest)return reply.code(409).send({error:"package_manifest_required",message:"Sichern Sie zuerst den aktuellen Paketstand unveränderlich."});
      let release;
      try{release=validateBindingReleaseRequest({companyId,credentialId:context.credential_id,portalId:context.portal_id,tenderId:req.params.id,lotKey,bidPackageHash:manifest.manifest_sha256,managementApprovalId:context.approval_request_id,expiresAt:req.body?.expiresAt||new Date(Date.now()+30*60*1000).toISOString()});}
      catch(error){return reply.code(422).send({error:error.code||"binding_release_invalid",message:"Die Freigabe muss eine gültige Ablaufzeit innerhalb der nächsten zwei Stunden haben."})}
      const client=await pool.connect();let saved,item;
      try{await client.query("BEGIN");await client.query("SELECT id FROM tender.submission_contexts WHERE id=$1 FOR UPDATE",[context.id]);await client.query("UPDATE tender.binding_action_releases SET status='EXPIRED' WHERE submission_context_id=$1 AND status IN('REQUESTED','APPROVED') AND expires_at<=now()",[context.id]);
        const prior=(await client.query("SELECT id,status,binding_sha256,expires_at,requested_at FROM tender.binding_action_releases WHERE company_id=$1 AND credential_id=$2 AND portal_id=$3 AND tender_id=$4 AND lot_key=$5 AND bid_package_hash=$6 AND status IN('REQUESTED','APPROVED') ORDER BY requested_at DESC LIMIT 1",[companyId,context.credential_id,context.portal_id,req.params.id,lotKey,manifest.manifest_sha256])).rows[0];
        if(prior)item=prior;else{const idempotencyKey=submissionHash({binding:release.bindingSha256,requestedBy:req.identity.userId});saved=(await client.query(`INSERT INTO tender.binding_action_releases(submission_context_id,company_id,credential_id,portal_id,tender_id,lot_key,bid_package_hash,management_approval_request_id,binding_sha256,idempotency_key,requested_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,status,binding_sha256,expires_at,requested_at`,[context.id,companyId,context.credential_id,context.portal_id,req.params.id,lotKey,manifest.manifest_sha256,context.approval_request_id,release.bindingSha256,idempotencyKey,req.identity.userId,release.expiresAt])).rows[0];item=saved;await client.query("INSERT INTO tender.binding_action_release_events(release_id,event_type,actor_id,binding_sha256,metadata) VALUES($1,'REQUESTED',$2,$3,$4::jsonb)",[saved.id,req.identity.userId,release.bindingSha256,JSON.stringify({internalFinalizationOnly:true,externalWrite:false,transmitted:false})]);}
        await client.query("COMMIT");
      }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
      return reply.code(saved?201:200).send({...item,idempotent:!saved,requiresDifferentManagementApprover:true,bindingExecutionAllowed:false,bindingEndpointsHttpStatus:423,external_submission_enabled:false,transmitted:false});
    },
  );
  app.post(
    "/api/tenders/:id/binding-action-releases/:releaseId/approve",
    { preHandler:[requirePermission("tender.board.approve"),csrf] },
    async(req,reply)=>{
      if(!(await visibleTender(req,reply,req.params.id)))return;
      if(!validUuid(req.params.releaseId))return reply.code(400).send({error:"binding_release_id_invalid"});
      const row=(await pool.query(`SELECT release.*,latest.manifest_sha256 latest_package_hash,approval.status management_approval_status,(approval.expires_at IS NULL OR approval.expires_at>now()) management_approval_unexpired
        FROM tender.binding_action_releases release JOIN tender.approval_requests approval ON approval.id=release.management_approval_request_id
        LEFT JOIN LATERAL(SELECT manifest_sha256 FROM tender.submission_package_manifests WHERE submission_context_id=release.submission_context_id ORDER BY manifest_version DESC LIMIT 1)latest ON true
        WHERE release.id=$1 AND release.tender_id=$2`,[req.params.releaseId,req.params.id])).rows[0];
      if(!row)return reply.code(404).send({error:"binding_release_not_found"});
      if(!req.identity.permissions.includes("tender.admin")&&!req.identity.companyIds.includes(String(row.company_id)))return reply.code(403).send({error:"company_scope_forbidden"});
      if(!(await requireRegisteredScope(reply,row.tender_id,row.company_id)))return;
      const scope={companyId:row.company_id,credentialId:row.credential_id,portalId:row.portal_id,tenderId:row.tender_id,lotKey:row.lot_key,bidPackageHash:row.bid_package_hash,managementApprovalId:row.management_approval_request_id},current={scope:{...scope,bidPackageHash:row.latest_package_hash||""}};
      let approved;try{approved=authorizeBindingReleaseApproval({status:row.status,scope,expiresAt:row.expires_at,requestedBy:row.requested_by,managementApprovalValid:row.management_approval_status==="APPROVED"&&row.management_approval_unexpired},{userId:req.identity.userId,managementAuthorized:true,expectedBindingSha256:req.body?.bindingSha256},current);}catch(error){return reply.code(409).send({error:error.code||"binding_release_approval_denied",message:"Die Freigabe ist abgelaufen, verändert oder erfüllt das Vier-Augen-Prinzip nicht."})}
      const client=await pool.connect();let item;
      try{await client.query("BEGIN");item=(await client.query(`UPDATE tender.binding_action_releases release SET status='APPROVED',approved_by=$2,approved_at=now()
        WHERE release.id=$1 AND release.status='REQUESTED' AND release.expires_at>now() AND release.binding_sha256=$3
        AND EXISTS(SELECT 1 FROM tender.submission_package_manifests manifest WHERE manifest.submission_context_id=release.submission_context_id AND manifest.manifest_sha256=release.bid_package_hash AND manifest.manifest_version=(SELECT max(current.manifest_version) FROM tender.submission_package_manifests current WHERE current.submission_context_id=release.submission_context_id))
        AND EXISTS(SELECT 1 FROM tender.approval_requests approval WHERE approval.id=release.management_approval_request_id AND approval.status='APPROVED' AND (approval.expires_at IS NULL OR approval.expires_at>now()))
        RETURNING id,status,approved_at,expires_at`,[row.id,req.identity.userId,approved.bindingSha256])).rows[0];if(!item)throw Object.assign(Error("binding_release_changed"),{code:"BINDING_RELEASE_CHANGED"});await client.query("INSERT INTO tender.binding_action_release_events(release_id,event_type,actor_id,binding_sha256,metadata) VALUES($1,'APPROVED',$2,$3,$4::jsonb)",[row.id,req.identity.userId,approved.bindingSha256,JSON.stringify({fourEyes:true,managementApprovalId:row.management_approval_request_id,internalFinalizationOnly:true,externalWrite:false,transmitted:false})]);await client.query("COMMIT")}catch(error){await client.query("ROLLBACK");if(error.code==="BINDING_RELEASE_CHANGED")return reply.code(409).send({error:"binding_release_changed"});throw error}finally{client.release()}
      return {...item,internalFinalizationOnly:true,bindingExecutionAllowed:false,bindingEndpointsHttpStatus:423,external_submission_enabled:false,transmitted:false};
    },
  );
  app.post(
    "/api/tenders/:id/binding-action-releases/:releaseId/revoke",
    { preHandler:[requirePermission("tender.submission.approve"),csrf] },
    async(req,reply)=>{
      if(!(await visibleTender(req,reply,req.params.id)))return;
      if(!validUuid(req.params.releaseId))return reply.code(400).send({error:"binding_release_id_invalid"});
      const client=await pool.connect();let item;
      try{await client.query("BEGIN");const row=(await client.query("SELECT * FROM tender.binding_action_releases WHERE id=$1 AND tender_id=$2 FOR UPDATE",[req.params.releaseId,req.params.id])).rows[0];if(!row){await client.query("ROLLBACK");return reply.code(404).send({error:"binding_release_not_found"})}if(!req.identity.permissions.includes("tender.admin")&&!req.identity.companyIds.includes(String(row.company_id))){await client.query("ROLLBACK");return reply.code(403).send({error:"company_scope_forbidden"})}if(!(await requireRegisteredScope(reply,row.tender_id,row.company_id))){await client.query("ROLLBACK");return}if(["REQUESTED","APPROVED"].includes(row.status)){item=(await client.query("UPDATE tender.binding_action_releases SET status='REVOKED',revoked_by=$2,revoked_at=now() WHERE id=$1 RETURNING id,status,revoked_at",[row.id,req.identity.userId])).rows[0];await client.query("INSERT INTO tender.binding_action_release_events(release_id,event_type,actor_id,binding_sha256,metadata) VALUES($1,'REVOKED',$2,$3,$4::jsonb)",[row.id,req.identity.userId,row.binding_sha256,JSON.stringify({externalWrite:false,transmitted:false})])}else item={id:row.id,status:row.status,idempotent:true};await client.query("COMMIT")}catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
      return {...item,bindingExecutionAllowed:false,bindingEndpointsHttpStatus:423,external_submission_enabled:false,transmitted:false};
    },
  );
  app.post(
    "/api/tenders/:id/submission-events",
    { preHandler:[requirePermission(["tender.portal.manage","tender.admin"]),csrf] },
    async(req,reply)=>{
      if(!(await visibleTender(req,reply,req.params.id)))return;
      const contextId=String(req.body?.submissionContextId||""),context=(await pool.query("SELECT id,tender_id,company_id,lot_key,portal_id,credential_id FROM tender.submission_contexts WHERE id=$1 AND tender_id=$2",[contextId,req.params.id])).rows[0];
      if(!context)return reply.code(404).send({error:"submission_context_not_found"});
      if(!req.identity.permissions.includes("tender.admin")&&!req.identity.companyIds.includes(String(context.company_id)))return reply.code(403).send({error:"company_scope_forbidden"});
      if(!(await requireRegisteredScope(reply,context.tender_id,context.company_id)))return;
      const sourceMode=String(req.body?.sourceMode||"MANUAL_VERIFIED_IMPORT");
      if(!["MANUAL_VERIFIED_IMPORT","ACCEPTANCE_SANDBOX"].includes(sourceMode))return reply.code(400).send({error:"portal_event_source_forbidden",message:"Dieser Endpunkt akzeptiert nur geprüfte interne Imports oder isolierte Acceptance-Ereignisse."});
      if(req.body?.credentialId!=null&&String(req.body.credentialId)!==String(context.credential_id||""))return reply.code(409).send({error:"portal_event_credential_scope_mismatch"});
      let event;try{event=normalizeInboundEvent({type:req.body?.type,externalEventId:req.body?.externalEventId,scope:{tenderId:req.params.id,companyId:context.company_id,lotKey:context.lot_key,portalId:context.portal_id,credentialId:context.credential_id||null},observedAt:req.body?.observedAt,payload:req.body?.payload,sourceMode});}catch(error){return reply.code(400).send({error:error.code||"portal_event_invalid"})}
      const saved=(await pool.query(`INSERT INTO tender.portal_inbound_events(submission_context_id,tender_id,company_id,lot_key,portal_id,credential_id,event_type,external_event_id,source_mode,payload,event_sha256,idempotency_key,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id,event_type,observed_at`,[context.id,req.params.id,context.company_id,context.lot_key,context.portal_id,event.scope.credentialId,event.type,event.externalEventId,event.sourceMode,JSON.stringify(event.payload),event.eventSha256,event.idempotencyKey,event.observedAt])).rows[0];
      if(saved)await pool.query("INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'PORTAL_INBOUND_EVENT_RECORDED',$2,$3::jsonb)",[req.identity.userId,req.params.id,JSON.stringify({submissionContextId:context.id,eventType:event.type,eventSha256:event.eventSha256,sourceMode,externalWrite:false,transmitted:false})]);
      return reply.code(saved?201:200).send({item:saved||{event_type:event.type,observed_at:event.observedAt},idempotent:!saved,external_submission_enabled:false,transmitted:false});
    },
  );
  app.post(
    "/api/tenders/:id/submission-reconciliation-jobs",
    { preHandler:[requirePermission("tender.submission.prepare"),csrf] },
    async(req,reply)=>{
      if(!(await visibleTender(req,reply,req.params.id)))return;
      const contextId=String(req.body?.submissionContextId||""),kind=String(req.body?.jobKind||"");
      if(!["READ_ONLY_STATUS_POLL","RECEIPT_RECONCILIATION","MESSAGE_POLL","AMENDMENT_POLL","DEADLINE_POLL","OUTCOME_POLL"].includes(kind))return reply.code(400).send({error:"reconciliation_job_kind_invalid"});
      const context=(await pool.query("SELECT id,company_id,binding_sha256 FROM tender.submission_contexts WHERE id=$1 AND tender_id=$2",[contextId,req.params.id])).rows[0];
      if(!context)return reply.code(404).send({error:"submission_context_not_found"});
      if(!req.identity.permissions.includes("tender.admin")&&!req.identity.companyIds.includes(String(context.company_id)))return reply.code(403).send({error:"company_scope_forbidden"});
      if(!(await requireRegisteredScope(reply,req.params.id,context.company_id)))return;
      const key=submissionHash({contextId,kind,binding:context.binding_sha256,window:new Date().toISOString().slice(0,13)}),saved=(await pool.query(`INSERT INTO tender.submission_reconciliation_jobs(submission_context_id,job_kind,idempotency_key) VALUES($1,$2,$3) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id,job_kind,status,next_attempt_at`,[contextId,kind,key])).rows[0],item=saved||(await pool.query("SELECT id,job_kind,status,next_attempt_at FROM tender.submission_reconciliation_jobs WHERE idempotency_key=$1",[key])).rows[0];
      return reply.code(saved?202:200).send({item,idempotent:!saved,readOnly:true,external_submission_enabled:false,transmitted:false});
    },
  );
  const externalTenderActionLocked = (action) => async (_, reply) =>
    reply.code(423).send({
      error: `${action}_not_released`,
      message: "Diese externe oder rechtlich bindende Portalaktion ist nicht freigegeben. Es wurde nichts übermittelt.",
      external_submission_enabled: false,
      transmitted: false,
    });
  app.post(
    "/api/tenders/:id/participation",
    { preHandler: [requirePermission("tender.submission.approve"), csrf] },
    externalTenderActionLocked("participation"),
  );
  app.post(
    "/api/tenders/:id/withdrawal",
    { preHandler: [requirePermission("tender.submission.approve"), csrf] },
    externalTenderActionLocked("withdrawal"),
  );
  app.post(
    "/api/tenders/:id/revocation",
    { preHandler: [requirePermission("tender.submission.approve"), csrf] },
    externalTenderActionLocked("revocation"),
  );
  app.post(
    "/api/tenders/:id/bidder-communications",
    { preHandler: [requirePermission("tender.question.approve"), csrf] },
    externalTenderActionLocked("bidder_communication"),
  );
  app.post(
    "/api/tools/match",
    { preHandler: [requirePermission("tender.evaluate"), csrf] },
    async (req) => matchTender(req.body?.tender || {}, req.body?.rule || {}),
  );
  app.post(
    "/api/tools/decision",
    { preHandler: [requirePermission("tender.evaluate"), csrf] },
    async (req) =>
      evaluateGoNoGo(req.body?.input || {}, req.body?.config || {}),
  );
  app.post(
    "/api/tools/board-brief",
    { preHandler: [requirePermission("tender.board.approve"), csrf] },
    async (req) => boardBrief(req.body?.tender || {}, req.body?.decision || {}),
  );
  app.post(
    "/api/tools/document/validate",
    { preHandler: [requirePermission("tender.document.analyze"), csrf] },
    async (req) => validateDocument(req.body || {}),
  );
  app.post(
    "/api/tools/document/extract",
    { preHandler: [requirePermission("tender.document.analyze"), csrf] },
    async (req) => ({
      items: buildRequirementMatrix(
        extractRequirements(req.body?.text, req.body?.source),
      ),
    }),
  );
  app.post(
    "/api/tools/calculation",
    { preHandler: [requirePermission("tender.calculation.create"), csrf] },
    async (req) => ({
      result: calculateScenario(req.body?.input || {}, req.body?.config || {}),
      sensitivity: sensitivity(req.body?.input || {}, req.body?.config || {}),
    }),
  );
  app.post(
    "/api/tools/document/prepare",
    { preHandler: [requirePermission("tender.offer.generate"), csrf] },
    async (req) =>
      prepareDocument(req.body?.template || {}, req.body?.context || {}),
  );
  app.get("/api/tenders/:id/required-documents",{preHandler:read},async(req,reply)=>{
    if(!(await visibleTender(req,reply,req.params.id)))return;
    const companyId=String(req.query?.company||""),lotKey=String(req.query?.lot||"");
    if(!req.identity.permissions.includes("tender.admin")&&!req.identity.companyIds.includes(companyId))return reply.code(403).send({error:"company_scope_forbidden"});
    if(!(await requireRegisteredScope(reply,req.params.id,companyId)))return;
    const items=await requiredDocumentContext(req.params.id,companyId,lotKey),missing=items.filter(x=>x.mandatory&&x.submission_relevant&&!["VALIDATED","NOT_REQUIRED","SUPERSEDED"].includes(x.satisfaction_status));
    return {items,summary:{total:items.length,missing:missing.length,available:items.filter(x=>x.satisfaction_status==="AVAILABLE").length,uploaded:items.filter(x=>x.current_upload_id).length,validated:items.filter(x=>x.satisfaction_status==="VALIDATED").length,manualReview:items.filter(x=>x.satisfaction_status==="MANUAL_REVIEW_REQUIRED").length,rejected:items.filter(x=>x.satisfaction_status==="REJECTED").length,complete:items.length>0&&missing.length===0,discoveryComplete:items.length>0},transmitted:false};
  });
  const requiredOriginalContext=async(req,reply)=>{
    if(!(await visibleTender(req,reply,req.params.id)))return null;
    const companyId=String(req.query?.company||req.body?.company||""),lotKey=String(req.query?.lot??req.body?.lot??"");
    if(!validUuid(req.params.requiredDocumentId)||!validUuid(companyId)){
      reply.code(400).send({error:"required_document_context_invalid",message:"Ausschreibung, Gesellschaft und Anforderung müssen eindeutig gewählt sein."});return null;
    }
    if(!req.identity.permissions.includes("tender.admin")&&!req.identity.companyIds.includes(companyId)){
      reply.code(403).send({error:"company_scope_forbidden"});return null;
    }
    if(!(await requireRegisteredScope(reply,req.params.id,companyId)))return null;
    const row=(await pool.query(`SELECT r.*,d.id original_document_id,d.filename original_filename,d.mime_type original_mime_type,d.payload_sha256 original_sha256,d.content original_content,d.procurement_verification_status original_verification_status,d.provenance original_provenance,v.version original_document_version,v.tender_id original_tender_id
      FROM tender.required_documents r LEFT JOIN tender.enrichment_documents d ON d.id=r.source_document_id LEFT JOIN tender.enrichment_versions v ON v.id=d.enrichment_version_id
      WHERE r.id=$1 AND r.tender_id=$2 AND r.company_id=$3 AND r.lot_key=$4`,[req.params.requiredDocumentId,req.params.id,companyId,lotKey])).rows[0];
    if(!row){reply.code(404).send({error:"required_document_not_found"});return null}
    const form=resolveRequiredOriginalForm(row,row.original_document_id?[{id:row.original_document_id,tender_id:row.original_tender_id,company_id:row.company_id,lot_key:row.lot_key,filename:row.original_filename,mime_type:row.original_mime_type,payload_sha256:row.original_sha256,content:row.original_content,procurement_verification_status:row.original_verification_status,document_version:row.original_document_version,explicit_form_mapping:hasExactOriginalFormProvenance(row,row.original_provenance)}]:[]);
    if(!form.downloadable){reply.code(409).send({error:"original_form_mapping_not_proven",mappingStatus:form.status,message:form.status==="AMBIGUOUS_MAPPING"?"Die Zuordnung ist mehrdeutig und muss fachlich geprüft werden.":"Zu dieser Anforderung ist kein eindeutig belegtes Originalformular zugeordnet."});return null}
    return {row,form,companyId,lotKey};
  };
  const sendScopedFile=(reply,{content,mimeType,filename,inline=false})=>reply
    .header("content-type",mimeType).header("content-disposition",`${inline?"inline":"attachment"}; filename*=UTF-8''${encodeURIComponent(safeOriginalFilename(filename))}`)
    .header("x-content-type-options","nosniff").header("cache-control","private, no-store").header("content-security-policy","sandbox").send(content);
  const requiredSourceContext=async(req,reply)=>{
    if(!(await visibleTender(req,reply,req.params.id)))return null;
    const companyId=String(req.query?.company||""),lotKey=String(req.query?.lot??"");
    if(!validUuid(req.params.requiredDocumentId)||!validUuid(companyId)){
      reply.code(400).send({error:"required_document_context_invalid",message:"Ausschreibung, Gesellschaft und Anforderung müssen eindeutig gewählt sein."});return null;
    }
    if(!req.identity.permissions.includes("tender.admin")&&!req.identity.companyIds.includes(companyId)){
      reply.code(403).send({error:"company_scope_forbidden"});return null;
    }
    if(!(await requireRegisteredScope(reply,req.params.id,companyId)))return null;
    const row=(await pool.query(`SELECT r.*,d.id source_id,d.filename source_filename,d.mime_type source_mime_type,d.payload_sha256 source_sha256,d.content source_content,v.version source_document_version,v.tender_id source_tender_id
      FROM tender.required_documents r
      JOIN tender.enrichment_documents d ON d.id=r.source_document_id
      JOIN tender.enrichment_versions v ON v.id=d.enrichment_version_id AND v.tender_id=r.tender_id
      WHERE r.id=$1 AND r.tender_id=$2 AND r.company_id=$3 AND r.lot_key=$4 AND r.satisfaction_status<>'SUPERSEDED'`,[req.params.requiredDocumentId,req.params.id,companyId,lotKey])).rows[0];
    if(!row){reply.code(404).send({error:"required_source_document_not_found"});return null}
    const source=resolveRequiredSourceDocument(row,[{id:row.source_id,tender_id:row.source_tender_id,required_document_id:row.id,company_id:row.company_id,lot_key:row.lot_key,filename:row.source_filename,mime_type:row.source_mime_type,payload_sha256:row.source_sha256,content:row.source_content,document_version:row.source_document_version}]);
    if(!source.available){reply.code(404).send({error:"required_source_document_not_found"});return null}
    return source;
  };
  app.get("/api/tenders/:id/required-documents/:requiredDocumentId/source",{preHandler:read},async(req,reply)=>{
    const source=await requiredSourceContext(req,reply);if(!source)return;
    return sendScopedFile(reply,{content:source.candidate.content,mimeType:source.mimeType,filename:source.filename,inline:true});
  });
  app.get("/api/tenders/:id/required-documents/:requiredDocumentId/source/download",{preHandler:read},async(req,reply)=>{
    const source=await requiredSourceContext(req,reply);if(!source)return;
    return sendScopedFile(reply,{content:source.candidate.content,mimeType:source.mimeType,filename:source.filename});
  });
  app.get("/api/tenders/:id/required-documents/:requiredDocumentId/original",{preHandler:read},async(req,reply)=>{
    const context=await requiredOriginalContext(req,reply);if(!context)return;
    return sendScopedFile(reply,{content:context.form.candidate.content,mimeType:context.form.mimeType,filename:context.form.candidate.filename});
  });
  app.post("/api/tenders/:id/required-documents/:requiredDocumentId/working-copy",{preHandler:[requirePermission("tender.document.analyze"),csrf]},async(req,reply)=>{
    const context=await requiredOriginalContext(req,reply);if(!context)return;
    if(!context.form.editable)return reply.code(409).send({error:"original_form_not_safely_editable",message:"Das belegte Original ist kein sicher digital bearbeitbares PDF-, DOCX- oder XLSX-Formular."});
    const source=context.form.candidate,filename=safeOriginalFilename(`Arbeitskopie-${source.filename}`),sha256=crypto.createHash("sha256").update(source.content).digest("hex"),client=await pool.connect();
    try{await client.query("BEGIN");const existing=(await client.query("SELECT id,version,filename,media_type,sha256 FROM tender.required_document_working_copies WHERE required_document_id=$1 AND source_sha256=$2 AND is_current FOR UPDATE",[context.row.id,source.payload_sha256])).rows[0];
      if(existing){await client.query("COMMIT");return {item:existing,idempotent:true,transmitted:false}}
      await client.query("UPDATE tender.required_document_working_copies SET is_current=false WHERE required_document_id=$1 AND is_current",[context.row.id]);
      const version=Number((await client.query("SELECT coalesce(max(version),0)+1 version FROM tender.required_document_working_copies WHERE required_document_id=$1",[context.row.id])).rows[0].version),item=(await client.query(`INSERT INTO tender.required_document_working_copies(required_document_id,tender_id,lot_key,company_id,source_document_id,source_sha256,version,filename,media_type,content,sha256,prepared_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,version,filename,media_type,sha256`,[context.row.id,context.row.tender_id,context.row.lot_key,context.row.company_id,source.id,source.payload_sha256,version,filename,source.mime_type,source.content,sha256,req.identity.userId])).rows[0];
      await client.query("INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'REQUIRED_ORIGINAL_WORKING_COPY_PREPARED',$2,$3::jsonb)",[req.identity.userId,context.row.tender_id,JSON.stringify({requiredDocumentId:context.row.id,sourceDocumentId:source.id,sourceSha256:source.payload_sha256,workingCopyId:item.id,version,companyId:context.row.company_id,lotKey:context.row.lot_key,originalUnchanged:true,legalConfirmationAdded:false,externalWrite:false,transmitted:false})]);
      await client.query("COMMIT");return reply.code(201).send({item,idempotent:false,transmitted:false});
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
  });
  app.get("/api/tenders/:id/required-documents/:requiredDocumentId/working-copy",{preHandler:read},async(req,reply)=>{
    const context=await requiredOriginalContext(req,reply);if(!context)return;
    const row=(await pool.query("SELECT content,media_type,filename FROM tender.required_document_working_copies WHERE required_document_id=$1 AND tender_id=$2 AND company_id=$3 AND lot_key=$4 AND is_current",[context.row.id,context.row.tender_id,context.companyId,context.lotKey])).rows[0];
    if(!row)return reply.code(404).send({error:"working_copy_not_found"});return sendScopedFile(reply,{content:row.content,mimeType:row.media_type,filename:row.filename,inline:row.media_type==="application/pdf"});
  });
  app.get("/api/management/required-documents-inbox",{preHandler:read},async(req)=>{
    const companyIds=req.identity.permissions.includes("tender.admin")?null:req.identity.companyIds;
    const rows=(await pool.query(`SELECT r.id,r.tender_id,r.requirement_title,r.requirement_description,r.source_reference,r.source_page,r.category,r.document_type,r.mandatory,r.submission_relevant,r.satisfaction_status,r.lot_key,r.company_id,t.title,t.offer_deadline,c.legal_name company_name,fp.service_line,coalesce(p.display_name,'Kein Submission-Portal gebunden') portal_name,
      CASE WHEN t.offer_deadline<now()+interval '2 days' THEN 'CRITICAL' ELSE 'NORMAL' END priority
      FROM tender.required_documents r JOIN tender.current_registered_tender_company_portals registered ON registered.tender_id=r.tender_id AND registered.company_id=r.company_id JOIN tender.tenders t ON t.id=r.tender_id JOIN tender.enterprise_company_links c ON c.company_id=r.company_id
      LEFT JOIN tender.final_preflight_contexts fp ON fp.tender_id=r.tender_id AND fp.company_id=r.company_id AND fp.lot_key=r.lot_key AND fp.is_current
      LEFT JOIN tender.submission_contexts sc ON sc.id=fp.submission_context_id LEFT JOIN tender.portal_registry p ON p.id=sc.portal_id
      WHERE r.mandatory AND r.submission_relevant AND r.satisfaction_status IN('MISSING','REJECTED','MANUAL_REVIEW_REQUIRED','UPLOADED_PENDING_VALIDATION')
      AND ($1::uuid[] IS NULL OR r.company_id=ANY($1)) AND ($2='' OR r.company_id::text=$2) AND ($3='' OR fp.service_line=$3) AND ($4='' OR r.tender_id::text=$4) AND ($5='' OR r.lot_key=$5) AND ($6='' OR (CASE WHEN t.offer_deadline<now()+interval '2 days' THEN 'CRITICAL' ELSE 'NORMAL' END)=$6)
      ORDER BY t.offer_deadline NULLS LAST,r.requirement_title`,[companyIds,String(req.query?.company||''),String(req.query?.serviceLine||''),String(req.query?.tender||''),String(req.query?.lot||''),String(req.query?.priority||'')])).rows;
    return {items:rows.map(x=>({...x,status_label:requirementLabel(x.satisfaction_status)})),filterLabel:"Unterlagen nachzureichen"};
  });
  app.get("/api/management/signature-workbench",{preHandler:read},async(req)=>{
    const companyIds=req.identity.permissions.includes("tender.admin")?null:req.identity.companyIds;
    const rows=(await pool.query(`SELECT sd.id,sd.tender_id,sd.lot_key,sd.company_id,sd.source_filename,sd.working_filename,sd.working_sha256,sd.required_role,sd.signature_type,sd.signature_location,sd.status,sd.version,sd.prepared_at,t.title,t.offer_deadline,c.legal_name company_name,fr.title requirement_title
      FROM tender.signature_documents sd JOIN tender.current_registered_tender_company_portals registered ON registered.tender_id=sd.tender_id AND registered.company_id=sd.company_id JOIN tender.tenders t ON t.id=sd.tender_id JOIN tender.enterprise_company_links c ON c.company_id=sd.company_id JOIN tender.final_preflight_requirements fr ON fr.id=sd.requirement_id
      WHERE sd.is_current AND ($1::uuid[] IS NULL OR sd.company_id=ANY($1)) ORDER BY t.offer_deadline NULLS LAST,t.title,sd.lot_key`,[companyIds])).rows;
    return {items:rows,transmitted:false};
  });
  app.get("/api/management/malware-scanner/health",{preHandler:read},async()=>{const result=await scannerHealth();return {status:result.status==="CLEAN"?"HEALTHY":"UNAVAILABLE",engine:result.engine,acceptingUploads:result.status==="CLEAN"}});
  app.post("/api/signature-workbench/prepare",{preHandler:[requirePermission("tender.offer.generate"),csrf]},async(req,reply)=>{
    const requirementId=String(req.body?.requirementId||"");
    if(!/^[0-9a-f-]{36}$/i.test(requirementId))return reply.code(400).send({error:"requirement_id_required"});
    const row=(await pool.query(`SELECT fr.*,fp.tender_id,fp.lot_key,fp.company_id,ed.content,ed.filename,ed.payload_sha256 FROM tender.final_preflight_requirements fr JOIN tender.final_preflight_contexts fp ON fp.id=fr.context_id JOIN tender.enrichment_documents ed ON ed.id=fr.source_document_id WHERE fr.id=$1 AND fr.action_group='SIGNATURE'`,[requirementId])).rows[0];
    if(!row)return reply.code(404).send({error:"signature_requirement_not_found"});
    if(!req.identity.permissions.includes("tender.admin")&&!req.identity.companyIds.includes(String(row.company_id)))return reply.code(403).send({error:"company_scope_forbidden"});
    if(!(await requireRegisteredScope(reply,row.tender_id,row.company_id)))return;
    const prepared=prepareSignatureCopy({content:row.content,filename:row.filename});
    const existing=(await pool.query("SELECT * FROM tender.signature_documents WHERE requirement_id=$1 AND is_current",[row.id])).rows[0];
    if(existing&&existing.working_sha256===prepared.sha256)return {item:{...existing,working_content:undefined},transmitted:false};
    const client=await pool.connect();try{await client.query("BEGIN");await client.query("UPDATE tender.signature_documents SET is_current=false WHERE requirement_id=$1 AND is_current",[row.id]);const version=Number((await client.query("SELECT coalesce(max(version),0)+1 version FROM tender.signature_documents WHERE requirement_id=$1",[row.id])).rows[0].version);const item=(await client.query(`INSERT INTO tender.signature_documents(context_id,requirement_id,tender_id,lot_key,company_id,source_document_id,source_sha256,source_filename,working_filename,working_content,working_sha256,required_role,signature_location,status,version,prepared_by,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'SIGNATURE_ACTION_REQUIRED',$14,$15,$16::jsonb) RETURNING *`,[row.context_id,row.id,row.tender_id,row.lot_key,row.company_id,row.source_document_id,row.payload_sha256,row.filename,prepared.filename,prepared.content,prepared.sha256,row.metadata?.signatoryRole||null,row.source_page?`Seite ${row.source_page}`:row.source_reference,version,req.identity.userId,JSON.stringify({originalUnchanged:true,sourceEvidenceSha256:row.source_evidence_sha256})])).rows[0];await client.query("INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'SIGNATURE_DOCUMENT_PREPARED',$2,$3::jsonb)",[req.identity.userId,row.tender_id,JSON.stringify({signatureDocumentId:item.id,requirementId:row.id,lotKey:row.lot_key,companyId:row.company_id,sha256:prepared.sha256})]);await client.query("COMMIT");return reply.code(201).send({item:{...item,working_content:undefined},transmitted:false})}catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
  });
  app.get("/api/signature-workbench/:id/file",{preHandler:read},async(req,reply)=>{const row=(await pool.query("SELECT working_content,working_filename,company_id,tender_id FROM tender.signature_documents WHERE id=$1 AND is_current",[req.params.id])).rows[0];if(!row)return reply.code(404).send({error:"signature_document_not_found"});if(!req.identity.permissions.includes("tender.admin")&&!req.identity.companyIds.includes(String(row.company_id)))return reply.code(403).send({error:"company_scope_forbidden"});if(!(await requireRegisteredScope(reply,row.tender_id,row.company_id)))return;return reply.header("content-type","application/pdf").header("content-disposition",`inline; filename*=UTF-8''${encodeURIComponent(row.working_filename)}`).header("x-content-type-options","nosniff").send(row.working_content)});
  app.post("/api/signature-workbench/:id/upload",{bodyLimit:30_000_000,preHandler:[requirePermission("tender.document.analyze"),csrf]},async(req,reply)=>{const row=(await pool.query("SELECT * FROM tender.signature_documents WHERE id=$1 AND is_current",[req.params.id])).rows[0];if(!row)return reply.code(404).send({error:"signature_document_not_found"});if(!req.identity.permissions.includes("tender.admin")&&!req.identity.companyIds.includes(String(row.company_id)))return reply.code(403).send({error:"company_scope_forbidden"});if(!(await requireRegisteredScope(reply,row.tender_id,row.company_id)))return;let content;try{const encoded=String(req.body?.base64||'').replace(/\s/g,'');content=Buffer.from(encoded,'base64');if(!encoded||content.toString('base64').replaceAll('=','')!==encoded.replaceAll('=',''))throw Error()}catch{return reply.code(400).send({error:"document_base64_invalid"})}const validation=inspectSignedPdf({content,sourceContent:row.working_content}),filename=String(req.body?.filename||'unterschrieben.pdf').slice(0,240),scan=await scanBuffer(content);await pool.query(`INSERT INTO tender.upload_malware_scans(object_type,object_id,tender_id,lot_key,company_id,sha256,size_bytes,engine,status,detail_code,created_by) VALUES('SIGNATURE_DOCUMENT',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[row.id,row.tender_id,row.lot_key,row.company_id,validation.sha256,content.length,scan.engine,scan.status==="INFECTED"?"QUARANTINED":scan.status,scan.detail,req.identity.userId]);if(scan.status!=="CLEAN")return reply.code(scan.status==="INFECTED"?422:503).send({error:scan.status==="INFECTED"?"document_rejected_malware":"malware_scanner_temporarily_unavailable",retryable:scan.status==="SCAN_ERROR"});validation.malwareScanStatus="CLEAN";const client=await pool.connect();try{await client.query('BEGIN');await client.query('UPDATE tender.signature_document_uploads SET is_current=false WHERE signature_document_id=$1 AND is_current',[row.id]);const version=Number((await client.query('SELECT coalesce(max(version),0)+1 version FROM tender.signature_document_uploads WHERE signature_document_id=$1',[row.id])).rows[0].version);const upload=(await client.query(`INSERT INTO tender.signature_document_uploads(signature_document_id,version,filename,media_type,size_bytes,sha256,content,validation_status,validation_details,malware_scan_status,uploaded_by) VALUES($1,$2,$3,'application/pdf',$4,$5,$6,$7,$8::jsonb,'CLEAN',$9) RETURNING id`,[row.id,version,filename,content.length,validation.sha256,content,validation.status,JSON.stringify(validation),req.identity.userId])).rows[0];await client.query('UPDATE tender.signature_documents SET status=$2 WHERE id=$1',[row.id,validation.status]);await client.query("INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'SIGNED_DOCUMENT_UPLOADED',$2,$3::jsonb)",[req.identity.userId,row.tender_id,JSON.stringify({signatureDocumentId:row.id,uploadId:upload.id,version,sha256:validation.sha256,status:validation.status,malwareScan:'CLEAN',lotKey:row.lot_key,companyId:row.company_id})]);await client.query('COMMIT');return reply.code(201).send({uploadId:upload.id,version,validation,transmitted:false})}catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}});
  app.post("/api/tenders/:id/required-documents/:requiredDocumentId/upload",{bodyLimit:30_000_000,preHandler:[requirePermission("tender.document.analyze"),csrf]},async(req,reply)=>{
    if(!(await visibleTender(req,reply,req.params.id)))return;
    const companyId=String(req.body?.company||""),lotKey=String(req.body?.lot??"");
    if(!validUuid(req.params.requiredDocumentId)||!validUuid(companyId))return reply.code(400).send({error:"required_document_context_invalid"});
    if(!req.identity.permissions.includes("tender.admin")&&!req.identity.companyIds.includes(companyId))return reply.code(403).send({error:"company_scope_forbidden"});
    if(!(await requireRegisteredScope(reply,req.params.id,companyId)))return;
    const requirement=(await pool.query("SELECT * FROM tender.required_documents WHERE id=$1 AND tender_id=$2 AND company_id=$3 AND lot_key=$4 AND satisfaction_status<>'SUPERSEDED'",[req.params.requiredDocumentId,req.params.id,companyId,lotKey])).rows[0];
    if(!requirement)return reply.code(404).send({error:"required_document_not_found"});
    const encoded=String(req.body?.base64||"").replace(/\s/g,"");let buffer;
    try{buffer=Buffer.from(encoded,"base64");if(!encoded||buffer.toString("base64").replaceAll("=","")!==encoded.replaceAll("=",""))throw Error();}catch{return reply.code(400).send({error:"document_base64_invalid"});}
    const filename=String(req.body?.filename||"").slice(0,240),mediaType=String(req.body?.mediaType||"application/octet-stream");
    if(!filename)return reply.code(400).send({error:"filename_required"});
    const validation=inspectUploadedDocument({buffer,filename,mediaType,requirement});
    const scan=await scanBuffer(buffer);await pool.query(`INSERT INTO tender.upload_malware_scans(object_type,object_id,tender_id,lot_key,company_id,sha256,size_bytes,engine,status,detail_code,created_by) VALUES('REQUIRED_DOCUMENT',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[requirement.id,requirement.tender_id,requirement.lot_key,requirement.company_id,validation.sha256,buffer.length,scan.engine,scan.status==="INFECTED"?"QUARANTINED":scan.status,scan.detail,req.identity.userId]);if(scan.status!=="CLEAN")return reply.code(scan.status==="INFECTED"?422:503).send({error:scan.status==="INFECTED"?"document_rejected_malware":"malware_scanner_temporarily_unavailable",retryable:scan.status==="SCAN_ERROR"});validation.malwareScanStatus="CLEAN";
    const client=await pool.connect();try{await client.query("BEGIN");
      await client.query("UPDATE tender.required_document_uploads SET is_current=false WHERE required_document_id=$1 AND is_current",[requirement.id]);
      const version=Number((await client.query("SELECT coalesce(max(version),0)+1 version FROM tender.required_document_uploads WHERE required_document_id=$1",[requirement.id])).rows[0].version),
        upload=(await client.query(`INSERT INTO tender.required_document_uploads(required_document_id,tender_id,lot_key,company_id,version,filename,media_type,size_bytes,sha256,content,validation_status,validation_summary,validation_details,malware_scan_status,uploaded_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15) RETURNING *`,[requirement.id,requirement.tender_id,requirement.lot_key,requirement.company_id,version,filename,validation.detectedMediaType,buffer.length,validation.sha256,buffer,validation.outcome,validation.errors[0]||validation.warnings[0]||"Dokument hochgeladen – fachliche Prüfung erforderlich.",JSON.stringify(validation),validation.malwareScanStatus,req.identity.userId])).rows[0];
      await client.query("UPDATE tender.required_documents SET current_upload_id=$2,satisfaction_status=$3,updated_at=now() WHERE id=$1",[requirement.id,upload.id,validation.outcome]);
      await client.query("INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'REQUIRED_DOCUMENT_UPLOADED',$2,$3::jsonb)",[req.identity.userId,requirement.tender_id,JSON.stringify({requiredDocumentId:requirement.id,uploadId:upload.id,version,sha256:validation.sha256,outcome:validation.outcome,lotKey:requirement.lot_key,companyId:requirement.company_id})]);
      const updated={...requirement,satisfaction_status:validation.outcome},recheck=await runRequiredDocumentRecheck(client,updated,upload,req.identity.userId);await client.query("COMMIT");
      return reply.code(201).send({upload:{id:upload.id,version,filename,sizeBytes:buffer.length,sha256:validation.sha256,status:validation.outcome,statusLabel:requirementLabel(validation.outcome),details:validation},recheck,transmitted:false});
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
  });
  app.post("/api/tenders/:id/required-documents/:requiredDocumentId/review",{preHandler:[requirePermission("tender.document.analyze"),csrf]},async(req,reply)=>{
    if(!(await visibleTender(req,reply,req.params.id)))return;const decision=String(req.body?.decision||""),reason=String(req.body?.reason||"").trim();
    if(!["VALIDATED","REJECTED"].includes(decision)||!reason)return reply.code(400).send({error:"review_decision_and_reason_required"});
    const client=await pool.connect();try{await client.query("BEGIN");const requirement=(await client.query("SELECT * FROM tender.required_documents WHERE id=$1 AND tender_id=$2 FOR UPDATE",[req.params.requiredDocumentId,req.params.id])).rows[0];
      if(!requirement||!requirement.current_upload_id){await client.query("ROLLBACK");return reply.code(404).send({error:"uploaded_document_not_found"})}
      if(!req.identity.permissions.includes("tender.admin")&&!req.identity.companyIds.includes(String(requirement.company_id))){await client.query("ROLLBACK");return reply.code(403).send({error:"company_scope_forbidden"})}
      if(!(await requireRegisteredScope(reply,requirement.tender_id,requirement.company_id))){await client.query("ROLLBACK");return}
      const upload=(await client.query("UPDATE tender.required_document_uploads SET validation_status=$2,validation_summary=$3,reviewed_by=$4,reviewed_at=now() WHERE id=$1 RETURNING *",[requirement.current_upload_id,decision,reason,req.identity.userId])).rows[0];
      await client.query("UPDATE tender.required_documents SET satisfaction_status=$2,updated_at=now() WHERE id=$1",[requirement.id,decision]);
      await client.query("INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,$2,$3,$4::jsonb)",[req.identity.userId,decision==="VALIDATED"?"REQUIRED_DOCUMENT_CONFIRMED":"REQUIRED_DOCUMENT_REJECTED",requirement.tender_id,JSON.stringify({requiredDocumentId:requirement.id,uploadId:upload.id,reason})]);
      const recheck=await runRequiredDocumentRecheck(client,{...requirement,satisfaction_status:decision},upload,req.identity.userId);await client.query("COMMIT");return {status:decision,statusLabel:requirementLabel(decision),recheck,transmitted:false};
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
  });
  app.get("/api/tenders/:id/required-documents/:requiredDocumentId/download",{preHandler:read},async(req,reply)=>{
    if(!(await visibleTender(req,reply,req.params.id)))return;const row=(await pool.query(`SELECT u.content,u.media_type,u.filename,r.company_id,r.tender_id FROM tender.required_documents r JOIN tender.required_document_uploads u ON u.id=r.current_upload_id WHERE r.id=$1 AND r.tender_id=$2`,[req.params.requiredDocumentId,req.params.id])).rows[0];
    if(!row)return reply.code(404).send({error:"uploaded_document_not_found"});if(!req.identity.permissions.includes("tender.admin")&&!req.identity.companyIds.includes(String(row.company_id)))return reply.code(403).send({error:"company_scope_forbidden"});if(!(await requireRegisteredScope(reply,row.tender_id,row.company_id)))return;
    return reply.header("content-type",row.media_type).header("content-disposition",`attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`).header("x-content-type-options","nosniff").send(row.content);
  });
  app.post(
    "/api/tools/document/parse-binary",
    {
      bodyLimit: 67_000_000,
      preHandler: [requirePermission("tender.document.analyze"), csrf],
    },
    async (req, reply) => {
      const encoded = req.body?.base64;
      if (typeof encoded !== "string" || encoded.length > 66_700_000)
        return reply.code(413).send({ error: "document_size_invalid" });
      let buffer;
      try {
        buffer = Buffer.from(encoded, "base64");
        if (
          buffer.length === 0 ||
          buffer.toString("base64").replaceAll("=", "") !==
            encoded.replace(/\s/g, "").replaceAll("=", "")
        )
          throw new Error("base64_invalid");
      } catch {
        return reply.code(400).send({ error: "document_base64_invalid" });
      }
      try {
        return await parseBinaryDocumentIsolated(
          { buffer, name: req.body?.name, mediaType: req.body?.mediaType },
          { timeoutMs: 15_000, maxOldGenerationSizeMb: 192 },
        );
      } catch (error) {
        return reply
          .code(422)
          .send({ error: error?.message || "document_parse_failed" });
      }
    },
  );
  app.post(
    "/api/tools/document/generate-binary",
    {
      bodyLimit: 2_000_000,
      preHandler: [requirePermission("tender.offer.generate"), csrf],
    },
    async (req, reply) => {
      try {
        const generated = await generateDocument(req.body || {});
        return {
          ...generated,
          buffer: undefined,
          base64: generated.buffer.toString("base64"),
        };
      } catch (error) {
        return reply
          .code(422)
          .send({ error: error?.message || "document_generation_failed" });
      }
    },
  );
  app.post(
    "/api/tools/portal/validate",
    { preHandler: [requirePermission("tender.portal.manage"), csrf] },
    async (req) => validatePortalAdapter(req.body || {}),
  );
  app.post(
    "/api/tools/action/prepare",
    { preHandler: [requirePermission("tender.submission.prepare"), csrf] },
    async (req) => prepareExternalAction(req.body || {}),
  );
  app.post(
    "/api/tools/action/transmit",
    { preHandler: [requirePermission("tender.submission.approve"), csrf] },
    async (_, reply) => reply.code(423).send({
      error: "external_submission_disabled",
      external_submission_enabled: false,
      transmitted: false,
    }),
  );
}
