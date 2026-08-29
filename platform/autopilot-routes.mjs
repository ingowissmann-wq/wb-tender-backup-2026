Warning: truncated output (original token count: 148475)
Total output lines: 8190

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
export const buildJobContinuation=(row)=>{
  const status=String(row.terminal_result||row.result_summary?.status||row.result_summary?.requiredAction||""),
    presentations={
      ACCOUNT_SETUP_REQUIRED:{title:"Portalzugang erforderlich",message:"Für diese Gesellschaft und dieses Portal muss ein Zugang eingerichtet oder die sichere Sitzung erneuert werden.",actionType:"MANAGE_PORTAL_ACCESS",actionLabel:"Gesellschaftsgebundenen Portalzugang öffnen"},
      MANUAL_MFA_REQUIRED:{title:"MFA-Bestätigung erforderlich",message:"Eine berechtigte Person muss die MFA-Prüfung im Portal fortsetzen. MFA-Codes werden weder gespeichert noch umgangen.",actionType:"CONTINUE_PORTAL_AUTHENTICATION",actionLabel:"Sichere MFA-Fortsetzung öffnen"},
      MANUAL_CAPTCHA_REQUIRED:{title:"CAPTCHA manuell erforderlich",message:"Das CAPTCHA muss durch eine berechtigte Person direkt im Portal gelöst werden. Eine automatische Umgehung ist gesperrt.",actionType:"CONTINUE_PORTAL_AUTHENTICATION",actionLabel:"Manuelle Portalfortsetzung öffnen"},
      DATA_CONTEXT_REPAIR_REQUIRED:{title:"Ausschreibungskontext prüfen",message:"Dokumenten- oder Abgabeportal, Gesellschaft, Version und Los müssen anhand autoritativer Nachweise eindeutig bestätigt werden.",actionType:"REVIEW_TENDER_CONTEXT",actionLabel:"Gebundenen Ausschreibungskontext öffnen"},
      ADAPTER_REPAIR_REQUIRED:{title:"Portaladapter prüfen",message:"Der registrierte Portaladapter benötigt eine technische Reparatur und eine nichtbindende Validierung.",actionType:"REVIEW_PORTAL_ADAPTER",actionLabel:"Portalprofil und Adapterstatus öffnen"},
      UNSUPPORTED_PORTAL_REQUIRES_ADAPTER:{title:"Portaladapter erforderlich",message:"Für dieses Portal muss der einheitliche Adaptervertrag implementiert und ohne verbindliche Abgabe validiert werden.",actionType:"REVIEW_PORTAL_ADAPTER",actionLabel:"Portalprofil für Adapterarbeit öffnen"},
      EXTERNAL_PORTAL_UNAVAILABLE:{title:"Externes Portal nicht verfügbar",message:"Das externe Portal war nach verifizierter Hostprüfung nicht erreichbar. Erst nach nachgewiesener Wiederherstellung erneut prüfen.",actionType:"REVIEW_PORTAL_AVAILABILITY",actionLabel:"Portalstatus öffnen"},
    }, presentation=presentations[status];
  if(!presentation)return null;
  const safeCode=(value)=>/^[A-Z0-9_]{3,160}$/.test(String(value||""))?String(value):null;
  return {...presentation,status,
    reasonCode:safeCode(row.result_summary?.reasonCode||row.result_summary?.originalReasonCode),
    repairAction:safeCode(row.result_summary?.repairAction),
    tenderId:row.tender_id||null,companyId:row.company_id||null,portalId:row.portal_id||null,
    lotKey:row.lot_key||null,enrichmentVersionId:row.enrichment_version_id||null,
    externalWrite:false,automaticExternalAction:false};
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
  credentialStateFingerprint,
  credentialPortalEligibility,
  credentialAccountEligibility,
  credentialJobEligibility,
  portalCatalogProfile,
  tenderCredentialPortalEligibility,
  portalCredentialJobKey,
  testReadOnlyPortal,
} from "./portal-credentials.mjs";
import {withTedServiceCatalog} from "./portal-capability-policy.mjs";
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
import { submissionAdapterFor } from "./submission-adapters.mjs";
import {
  effectiveRequiredDocumentStatus,
  inspectUploadedDocument,
  isRequiredDocumentBlocker,
  isRequiredDocumentMissing,
  materiallyEditedPdfWorkingCopy,
  requirementLabel,
  submissionDocumentsComplete,
} from "./required-documents.mjs";
import { inspectSignedPdf, prepareSignatureCopy } from "./signature-workbench.mjs";
import { scanBuffer, scannerHealth } from "./malware-scanner.mjs";
import {
  classifyRequirementEvidence,
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
import { fillPdfAcroForm, inspectPdfAcroForm } from "./required-pdf-form.mjs";
import { inspectPdfForOverlay, renderPdfOverlays, summarizePdfOverlays } from "./required-pdf-overlay.mjs";
import { DOCX_MIME, XLSX_MIME, fillOfficeForm, inspectOfficeForm } from "./required-office-form.mjs";
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
import { registeredTenderPortalScope, requireRegisteredTenderPortalScope } from "./registered-portal-scope.mjs";
import { loadTenderLinkEvidence, safeExternalHttpsUrl } from "./tender-link-evidence.mjs";
import {
  PORTAL_NAVIGATION_RELEASE,
  decoratePortalNavigation,
  portalNavigationHref,
  safePortalReturnTo,
  validPortalNavigationUuid,
} from "./portal-navigation.mjs";
import {
  canonicalPortalAccessStatus,
  searchPortalResults,
} from "./portal-management-search.mjs";
import { portalAccessPresentation } from "./canonical-portal-access.mjs";
import { normalizeTenderContext } from "./tender-context-contract.mjs";
import { evaluateProfile, profileFieldByKey, profileFieldDefinitions, profileFingerprint, profileSourceTypeLabels, setProfileField } from "./company-profile-completion.mjs";
import { buildParticipationReadiness } from "./participation-readiness.mjs";

export function registerAutopilotRoutes(
  app,
  { pool, maintenancePool = pool, requirePermission, csrf, visibleTender, scanDocument = scanBuffer },
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
        `SELECT company.company_id,company.legal_name,company.sector_slug,scope.tenant_id,scope.canonical_service,scope.profile_id,scope.active_region_version_id,
          active_version.id active_configuration_version_id,
          CASE scope.canonical_service WHEN 'facility_management' THEN 'facility-management' WHEN 'emergency_services' THEN 'emergency-services' ELSE scope.canonical_service END service_line
         FROM tender.enterprise_company_links company JOIN tender.configuration_scopes scope ON scope.company_id=company.company_id AND scope.profile_id=company.tender_profile_id
         LEFT JOIN tender.configuration_active_parameters active ON active.company_id=scope.company_id AND active.parameter_key='A08'
           AND (CASE active.service_line WHEN 'facility-management' THEN 'facility_management' WHEN 'emergency-services' THEN 'emergency_services' ELSE active.service_line END)=scope.canonical_service
         LEFT JOIN tender.configuration_versions active_version ON active_version.id=active.version_id
           AND active_version.tenant_id=scope.tenant_id AND active_version.company_id=scope.company_id
           AND active_version.canonical_service=scope.canonical_service AND active_version.profile_id=scope.profile_id AND active_version.status='ACTIVE'
         WHERE company.active=true ORDER BY company.legal_name`,
      )
    ).rows.filter(
      (row) =>
        identity.permissions.includes("tender.admin") ||
        identity.companyIds.includes(String(row.company_id)),
    );
  const requireRegisteredScope = (reply, tenderId, companyId,options={}) =>
    requireRegisteredTenderPortalScope(pool, reply, { tenderId, companyId,...options });
  const resolveDocumentScope = async (reply, tenderId, companyId,lotKey=null) => {
    const source = (await pool.query(`SELECT tender.source_code,EXISTS(
      SELECT 1 FROM tender.tender_external_links link
      WHERE link.tender_id=tender.id AND link.public_access=true
        AND link.role IN('NOTICE','NOTICE_VIEW','PUBLIC_DOCUMENT','PROCUREMENT_DOCUMENT')
        AND link.verification_status IN('DISCOVERED','HTTP_VERIFIED')) has_public_documents,
      EXISTS(SELECT 1 FROM tender.import_raw_payloads raw
        WHERE raw.source_code='TED' AND raw.external_id=tender.external_id
          AND raw.processing_status IN('IMPORTED','PROCESSED')) has_retained_ted_notice
      FROM tender.tenders tender WHERE tender.id=$1`, [tenderId])).rows[0];
    if (source?.source_code === "TED" && (source.has_public_documents || source.has_retained_ted_notice)) {
      const portals=(await pool.query(`SELECT resolution.portal_id,portal.adapter_id,portal.adapter_version
        FROM tender.tender_portal_resolutions resolution
        JOIN tender.portal_registry portal ON portal.id=resolution.portal_id
          AND portal.adapter_enabled=true AND portal.adapter_validation_status IN('VALIDATED','VALIDATED_READ_ONLY','PRODUCTION_VALIDATED')
          AND 'PUBLIC_DOCUMENTS_POSSIBLE'=ANY(coalesce(portal.capabilities,'{}'::text[]))
        JOIN LATERAL(SELECT candidate.id FROM tender.tender_versions candidate
          WHERE candidate.tender_id=resolution.tender_id ORDER BY candidate.version DESC LIMIT 1)version
          ON version.id=resolution.tender_version_id
        WHERE resolution.tender_id=$1 AND resolution.evidence_role='PROCUREMENT_DOCUMENT'
          AND resolution.resolution_status='UNIQUE_EVIDENCE'
          AND EXISTS(SELECT 1 FROM tender.tender_external_links link WHERE link.tender_id=resolution.tender_id
            AND link.role='PROCUREMENT_DOCUMENT' AND link.public_access=true
            AND link.verification_status IN('DISCOVERED','HTTP_VERIFIED')
            AND lower(coalesce(link.final_host,link.original_host))=lower(portal.canonical_domain))`,[tenderId])).rows;
      if(portals.length===1)return {publicSource:true,portal_id:portals[0].portal_id,credential_id:null,
        adapter_id:portals[0].adapter_id,adapter_version:portals[0].adapter_version};
      reply.code(409).send({error:"PUBLIC_DOCUMENT_PORTAL_NOT_UNIQUELY_VALIDATED",status:"DATA_CONTEXT_REPAIR_REQUIRED",
        message:"Das öffentliche Dokumentenportal ist nicht eindeutig und read-only validiert.",externalSubmission:false,transmitted:false});
      return null;
    }
    return requireRegisteredScope(reply, tenderId, companyId,{lotKey,portalRole:"DOCUMENT_PORTAL"});
  };
  const requireParticipationEligible = async (reply,tenderId,lotKey) => {
    const row=(await pool.query("SELECT id,source_lifecycle_status,participation_status,participation_block_reason,notice_classification,offer_deadline FROM tender.tenders WHERE id=$1",[tenderId])).rows[0];
    if(!row){reply.code(404).send({error:"tender_not_found"});return null}
    const normalizedLot=String(lotKey||"").trim();
    const lot=normalizedLot?(await pool.query("SELECT lot_key,lifecycle_status,participation_status,participation_block_reason,offer_deadline FROM tender.tender_lot_lifecycles WHERE tender_id=$1 AND lot_key=$2 AND is_current",[tenderId,normalizedLot])).rows[0]:null;
    if(row.source_lifecycle_status!=="ACTIVE"||!['ELIGIBLE','PARTIALLY_ELIGIBLE'].includes(row.participation_status)||!lot||lot.lifecycle_status!=="ACTIVE"||lot.participation_status!=="ELIGIBLE"||!lot.offer_deadline||new Date(lot.offer_deadline)<=new Date()){
      reply.code(409).send({error:row.participation_block_reason||"TENDER_NOT_PARTICIPATION_ELIGIBLE",message:"Dieses Verfahren ist nicht für eine Teilnahmeaktion freigegeben.",noticeClassification:row.notice_classification,lifecycle:row.source_lifecycle_status,nextAction:"VERFAHRENSHISTORIE_ANZEIGEN"});return null
    }
    return {...row,lot_key:lot.lot_key,lot_offer_deadline:lot.offer_deadline};
  };
  const lotSelectionGet = async (req, reply) => {
    const tenderId=String(req.params.tenderId||""),companyId=String(req.query?.company||"");
    if(!validUuid(tenderId)||!validUuid(companyId))return reply.code(400).send({error:"complete_lot_selection_scope_required"});
    if(!(await visibleTender(req,reply,tenderId)))return;
    const companies=await accessibleCompanies(req.identity);
    if(!companies.some(x=>String(x.company_id)===companyId))return reply.code(403).send({error:"company_scope_forbidden"});
    const item=(await pool.query(`SELECT selection.tender_id,selection.company_id,selection.lot_id,selection.source_lot_id,
      selection.created_at selected_at,selection.updated_at
      FROM tender.tender_lot_selections selection
      JOIN tender.lots lot ON lot.id=selection.lot_id AND lot.tender_id=selection.tender_id AND lot.external_id=selection.source_lot_id
      WHERE selection.tenant_id=$1 AND selection.company_id=$2 AND selection.tender_id=$3`,[companies.find(x=>String(x.company_id)===companyId).tenant_id,companyId,tenderId])).rows[0]||null;
    return {item:item?{tenderId:item.tender_id,companyId:item.company_id,lotId:item.lot_id,lotKey:item.source_lot_id,selectedAt:item.selected_at,updatedAt:item.updated_at}:null,externalSubmission:false};
  };
  const lotSelectionSave = async (req, reply) => {
    const tenderId=String(req.params.tenderId||""),companyId=String(req.body?.companyId||""),lotKey=String(req.body?.lotKey||"").trim();
    if(!validUuid(tenderId)||!validUuid(companyId)||!lotKey)return reply.code(400).send({error:"complete_lot_selection_scope_required"});
    if(!(await visibleTender(req,reply,tenderId)))return;
    const companies=await accessibleCompanies(req.identity),company=companies.find(x=>String(x.company_id)===companyId);
    if(!company)return reply.code(403).send({error:"company_scope_forbidden"});
    const participation=await requireParticipationEligible(reply,tenderId,lotKey);if(!participation)return;
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`lot-selection:${company.tenant_id}:${companyId}:${tenderId}`]);
      const context=(await client.query(`SELECT lot.id lot_id,version.id tender_version_id,lifecycle.deadline_evidence_id,
          scope.canonical_service
        FROM tender.lots lot
        JOIN tender.tender_lot_lifecycles lifecycle ON lifecycle.tender_id=lot.tender_id
          AND lifecycle.lot_key=lot.external_id AND lifecycle.is_current
          AND lifecycle.lifecycle_status='ACTIVE' AND lifecycle.participation_status='ELIGIBLE'
          AND lifecycle.deadline_quality='EXACT' AND lifecycle.offer_deadline>now()
          AND lifecycle.deadline_evidence_id IS NOT NULL
        JOIN tender.configuration_scopes scope ON scope.tenant_id=$1 AND scope.company_id=$2
          AND scope.profile_id=$5
        JOIN LATERAL(SELECT candidate.id FROM tender.tender_versions candidate
          WHERE candidate.tender_id=lot.tender_id ORDER BY candidate.version DESC LIMIT 1)version ON true
        WHERE lot.tender_id=$3 AND lot.external_id=$4`,[company.tenant_id,companyId,tenderId,lotKey,company.profile_id])).rows;
      if(context.length!==1){await client.query("ROLLBACK");return reply.code(409).send({error:"LOT_SELECTION_CONTEXT_NOT_CANONICAL"})}
      const selected=context[0],inbox=(await client.query("SELECT id FROM tender.management_inbox WHERE tender_id=$1 AND company_id=$2 ORDER BY updated_at DESC,created_at DESC LIMIT 1",[tenderId,companyId])).rows[0],region=(await client.query("SELECT id FROM tender.region_evaluations WHERE tender_id=$1 AND company_id=$2 ORDER BY evaluation_version DESC LIMIT 1",[tenderId,companyId])).rows[0];
      const row=(await client.query(`INSERT INTO tender.tender_lot_selections(tenant_id,company_id,tender_id,tender_version_id,lot_id,source_lot_id,inbox_id,region_evaluation_id,canonical_service,deadline_evidence_id,selection_source,selected_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'EXPLICIT_SELECTION',$11)
        ON CONFLICT(tenant_id,company_id,tender_id) DO UPDATE SET tender_version_id=excluded.tender_version_id,
          lot_id=excluded.lot_id,source_lot_id=excluded.source_lot_id,inbox_id=excluded.inbox_id,
          region_evaluation_id=excluded.region_evaluation_id,canonical_service=excluded.canonical_service,
          deadline_evidence_id=excluded.deadline_evidence_id,selection_source=excluded.selection_source,
          selected_by=excluded.selected_by,updated_at=now()
        RETURNING tender_id,company_id,lot_id,source_lot_id,created_at selected_at,updated_at`,[company.tenant_id,companyId,tenderId,selected.tender_version_id,selected.lot_id,lotKey,inbox?.id||null,region?.id||null,selected.canonical_service,selected.deadline_evidence_id,req.identity.userId])).rows[0];
      await client.query(`INSERT INTO tender.user_lot_selections(tenant_id,user_id,tender_id,company_id,lot_key)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,tender_id,company_id) DO UPDATE
        SET lot_key=excluded.lot_key,selected_at=now(),updated_at=now()`,[company.tenant_id,req.identity.userId,tenderId,companyId,lotKey]);
      await client.query(`INSERT INTO tender.enrichment_context_bindings(enrichment_version_id,tenant_id,company_id,tender_id,tender_version_id,lot_id,source_lot_id,canonical_service,source_manifest_sha256)
        SELECT enrichment.id,$1,$2,$3,$4,$5,$6,$7,enrichment.payload_sha256
        FROM tender.enrichment_versions enrichment WHERE enrichment.tender_id=$3 AND enrichment.historical=false
          AND enrichment.payload_sha256 ~ '^[0-9a-f]{64}$' ORDER BY enrichment.version DESC LIMIT 1
        ON CONFLICT DO NOTHING`,[company.tenant_id,companyId,tenderId,selected.tender_version_id,selected.lot_id,lotKey,selected.canonical_service]);
      await client.query("INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'LOT_SELECTION_SAVED',$2,$3::jsonb)",[req.identity.userId,tenderId,JSON.stringify({companyId,lotId:selected.lot_id,lotKey,externalSubmission:false,transmitted:false})]);
      await client.query("COMMIT");
      return {item:{tenderId:row.tender_id,companyId:row.company_id,lotId:row.lot_id,lotKey:row.source_lot_id,selectedAt:row.selected_at,updatedAt:row.updated_at},persisted:true,externalSubmission:false};
    }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{client.release()}
  };
  for(const path of ["/api/lot-selections/:tenderId","/api/tender/lot-selections/:tenderId"]){
    app.get(path,{preHandler:read},lotSelectionGet);
    app.post(path,{preHandler:[read,csrf]},lotSelectionSave);
  }
  const requireQueryCompanyScope = async (req, reply, tenderId) => {
    const companies = await accessibleCompanies(req.identity);
    const company = companies.find(
      (row) => String(row.company_id) === String(req.query?.company || ""),
    );
    if (!company) {
      reply.code(403).send({ error: "company_scope_forbidden" });
      return null;
    }
    return requireRegisteredScope(reply, tenderId, company.company_id,{
      lotKey:String(req.query?.lot||req.query?.lotKey||"").trim()||null,
    });
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
        LEFT JOIN tender.current_portal_capability_truth feature
          ON feature.portal_family_key=portal.portal_family_key
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
    if(!readOnlyCandidate) await pool.query(`WITH matches AS(
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
    const rows = (await pool.query(`SELECT r.*,u.id upload_id,u.filename,u.media_type,u.size_bytes,u.sha256,u.version upload_version,
      u.source_type upload_source_type,u.source_working_copy_id,u.validation_status upload_validation_status,u.validation_summary,u.validation_details,u.uploaded_at,u.reviewed_at,
      p.id package_binding_id,p.bid_package_id,p.portal_upload_category mapped_portal_category,p.portal_field_id mapped_portal_field,
      source.id original_document_id,source.filename original_filename,source.mime_type original_mime_type,
      source.payload_sha256 original_sha256,source.content original_content,source.procurement_verification_status original_verification_status,
      source.provenance original_provenance,source_version.version original_document_version,source_version.tender_id original_tender_id,
      working.id working_copy_id,working.version working_copy_version,working.sha256 working_copy_sha256,
      working.source_document_id working_source_document_id,working.source_sha256 working_source_sha256,
      coalesce(working.editor_provenance->>'materiallyEdited','false')='true' OR EXISTS(
        SELECT 1 FROM jsonb_array_elements(coalesce(working.overlay_data,'[]'::jsonb)) element
        WHERE element->>'type'='mark' OR (element->>'type'='checkbox' AND element->>'checked'='true')
          OR (element->>'type' IN('text','note') AND btrim(coalesce(element->>'text',''))<>'')
      ) working_copy_material
      FROM tender.required_documents r
      LEFT JOIN tender.required_document_uploads u ON u.id=r.current_upload_id
      LEFT JOIN LATERAL(SELECT x.* FROM tender.required_document_package_bindings x WHERE x.required_document_id=r.id AND x.upload_id=u.id ORDER BY x.created_at DESC LIMIT 1)p ON true
      LEFT JOIN LATERAL(SELECT w.id,w.version,w.sha256,w.source_document_id,w.source_sha256,w.overlay_data,w.editor_provenance FROM tender.required_document_working_copies w WHERE w.required_document_id=r.id AND w.is_current LIMIT 1) working ON true
      LEFT JOIN tender.enrichment_documents source ON source.id=r.source_document_id
      LEFT JOIN tender.enrichment_versions source_version ON source_version.id=source.enrichment_version_id
      WHERE r.tender_id=$1 AND r.company_id=$2 AND r.lot_key=$3 ORDER BY r.mandatory DESC,r.requirement_title`,
      [tenderId,companyId,lotKey])).rows;
    return Promise.all(rows.map(async(row)=>{
      const source=resolveRequiredSourceDocument(row,row.original_document_id?[{
        id:row.original_document_id,tender_id:row.original_tender_id,required_document_id:row.id,
        company_id:row.company_id,lot_key:row.lot_key,filename:row.original_filename,mime_type:row.original_mime_type,
        payload_sha256:row.original_sha256,content:row.original_content,document_version:row.original_document_version,
      }]:[]);
      const form=await resolveRequiredOriginalForm(row,row.original_document_id?[{
        id:row.original_document_id,tender_id:row.original_tender_id,company_id:row.company_id,lot_key:row.lot_key,
        filename:row.original_filename,mime_type:row.original_mime_type,payload_sha256:row.original_sha256,
        content:row.original_content,procurement_verification_status:row.original_verification_status,
        document_version:row.original_document_version,explicit_form_mapping:hasExactOriginalFormProvenance(row,row.original_provenance),
      }]:[]);
      const classification=row.requirement_classification?{
        classification:row.requirement_classification,
        reason:row.classification_reason,
        actionType:row.requirement_classification==="FILLABLE_BIDDER_FORM"?"PDF_EDITOR":row.requirement_classification==="BID_TIME_UPLOAD_EVIDENCE"?"UPLOAD":"NONE",
      }:classifyRequirementEvidence(row.requirement_description);
      const effectiveStatus=effectiveRequiredDocumentStatus(row),manuallyExcluded=row.manual_submission_relevance_override===false,actionType=classification.classification==="FILLABLE_BIDDER_FORM"&&[DOCX_MIME,XLSX_MIME].includes(form.mimeType)?"OFFICE_EDITOR":classification.actionType,result={...row,requirement_classification:classification.classification,classification_reason:classification.reason,action_type:actionType,satisfaction_status:effectiveStatus,persisted_satisfaction_status:row.satisfaction_status,bid_submission_relevance_state:manuallyExcluded?"MANUALLY_NOT_REQUIRED":"REQUIRED",status_label:manuallyExcluded?"Manuell als für die Angebotsabgabe nicht erforderlich bestätigt":requirementLabel(effectiveStatus),source_document:{
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
    }));
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
    const linked=(await client.query(`UPDATE tender.final_preflight_requirements f SET status=$5,manual_submission_relevance_override=$6,updated_at=now() FROM tender.final_preflight_contexts c
      WHERE f.context_id=c.id AND c.is_current AND c.tender_id=$1 AND c.company_id=$2 AND c.lot_key=$3 AND f.requirement_key=$4 RETURNING f.id`,[requirement.tender_id,requirement.company_id,requirement.lot_key,requirement.requirement_code,requirement.satisfaction_status,requirement.manual_submission_relevance_override??null])).rows;
    const manuallyExcluded=requirement.manual_submission_relevance_override===false;
    if((["VALIDATED","NOT_REQUIRED"].includes(requirement.satisfaction_status)||manuallyExcluded)&&linked.length)await client.query("UPDATE tender.final_preflight_user_actions SET status='COMPLETED',completed_by=$2,completed_at=now(),updated_at=now() WHERE requirement_id=ANY($1::uuid[]) AND status IN('OPEN','IN_PROGRESS')",[linked.map(x=>x.id),actorId]);
    else if(linked.length)await client.query("UPDATE tender.final_preflight_user_actions SET status='OPEN',completed_by=NULL,completed_at=NULL,updated_at=now() WHERE requirement_id=ANY($1::uuid[]) AND status='COMPLETED'",[linked.map(x=>x.id)]);
    await client.query(`UPDATE tender.final_preflight_contexts c SET readiness_status=CASE WHEN NOT EXISTS(SELECT 1 FROM tender.final_preflight_requirements f WHERE f.context_id=c.id AND f.status NOT IN('VALIDATED','NOT_REQUIRED','SUPERSEDED') AND f.manual_submission_relevance_override IS DISTINCT FROM false) AND $4 THEN 'MANAGEMENT_REVIEW_REQUIRED' WHEN $6=false THEN readiness_status WHEN $5 IN('MISSING','REJECTED','AVAILABLE') THEN 'PACKAGE_INCOMPLETE' WHEN $5 IN('UPLOADED_PENDING_VALIDATION','MANUAL_REVIEW_REQUIRED') THEN 'WAITING_FOR_USER_INPUT' ELSE readiness_status END,updated_at=now()
      WHERE c.is_current AND c.tender_id=$1 AND c.company_id=$2 AND c.lot_key=$3`,[requirement.tender_id,requirement.company_id,requirement.lot_key,complete,requirement.satisfaction_status,requirement.manual_submission_relevance_override]);
    await client.query(`INSERT INTO tender.required_document_rechecks(required_document_id,trigger_upload_id,required_document_status,bid_package_status,portal_mapping_status,submission_gate_status,details)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[requirement.id,upload?.id||null,requirement.satisfaction_status,packageRow?(requirement.approval_relevant?"NEW_PACKAGE_REVISION_REQUIRED":"SUPPLEMENT_BOUND_TO_IMMUTABLE_PACKAGE"):"BID_PACKAGE_NOT_AVAILABLE",portalMappingStatus,gateStatus,JSON.stringify({pipeline:["REQUIRED_DOCUMENT_RECHECK","BID_PACKAGE_RECHECK","PORTAL_MAPPING_RECHECK","SUBMISSION_GATE_RECHECK"],allMandatorySubmissionDocumentsComplete:complete,manualSubmissionRelevanceOverride:requirement.manual_submission_relevance_override??null,externalSubmission:false,transmitted:false})]);
    await client.query("INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'REQUIRED_DOCUMENT_RECHECK_COMPLETED',$2,$3::jsonb)",[actorId,requirement.tender_id,JSON.stringify({requiredDocumentId:requirement.id,uploadId:upload?.id||null,gateStatus,portalMappingStatus,bidPackageId:packageRow?.id||null,transmitted:false})]);
    return {complete,gateStatus,portalMappingStatus,bidPackageId:packageRow?.id||null};
  };
  const reconcileDocumentRetries = async () => {
    const client=await maintenancePool.connect();try{await client.query("BEGIN");
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
  const readOnlyCandidate=process.env.WB_TENDER_READ_ONLY_CANDIDATE==="true",retryTimer=readOnlyCandidate?null:setInterval(()=>reconcileDocumentRetries().catch((error)=>app.log.error({error:error.message},"automatic document retry reconciliation failed")),15000);
  retryTimer?.unref?.();if(!readOnlyCandidate)setTimeout(()=>reconcileDocumentRetries().catch((error)=>app.log.error({error:error.message},"initial document retry reconciliation failed")),1000).unref?.();
  app.addHook("onClose",async()=>{if(retryTimer)clearInterval(retryTimer)});
  const reconcileFinalPreflight = async ({ tenderId = null, limit = 500 } = {}) => {
    const client=await maintenancePool.connect();
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
        AND (f.id IS NULL OR f.schema_version<7 OR f.tender_version_id<>tv.id OR f.document_revision_sha256 IS DISTINCT FROM coalesce(bp.document_revision_sha256,ev.payload_sha256)
          OR f.calculation_id IS DISTINCT FROM calc.id OR f.management_output_id IS DISTINCT FROM mo.id OR f.approval_request_id IS DISTINCT FROM approval.id
          OR f.bid_package_id IS DISTINCT FROM bp.id OR f.submission_context_id IS DISTINCT FROM sc.id OR f.company_profile_id IS DISTINCT FROM profile.id)
      ORDER BY t.offer_deadline LIMIT $2`,[tenderId,limit])).rows;
      let requirementCount=0;
      for(const context of contexts){
        await client.query(`UPDATE tender.final_preflight_contexts SET is_current=false,updated_at=now()
          WHERE tender_id=$1 AND lot_key=$2 AND company_id=$3 AND is_current AND tender_version_id<>$4`,[context.tender_id,context.lot_key,context.company_id,context.tender_version_id]);
        const saved=(await client.query(`INSERT INTO tender.final_preflight_contexts(tender_id,tender_version_id,lot_key,company_id,service_line,document_revision_sha256,calculation_id,management_output_id,approval_request_id,bid_package_id,submission_context_id,portal_session_id,company_profile_id,binding_valid,schema_version,transmitted)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,7,false)
          ON CONFLICT(tender_id,lot_key,company_id) WHERE is_current DO UPDATE SET tender_version_id=excluded.tender_version_id,service_line=excluded.service_line,document_revision_sha256=excluded.document_revision_sha256,calculation_id=excluded.calculation_id,management_output_id=excluded.management_output_id,approval_request_id=excluded.approval_request_id,bid_package_id=excluded.bid_package_id,submission_context_id=excluded.submission_context_id,portal_session_id=excluded.portal_session_id,company_profile_id=excluded.company_profile_id,binding_valid=excluded.binding_valid,schema_version=excluded.schema_version,updated_at=now() RETURNING *`,[context.tender_id,context.tender_version_id,context.lot_key,context.company_id,context.service_line,context.document_revision_sha256,context.calculation_id,context.management_output_id,context.approval_request_id,context.bid_package_id,context.submission_context_id,context.portal_session_id,context.company_profile_id,context.binding_valid])).rows[0];
        const existingMissing=(await client.query(`SELECT r.*,d.payload_sha256 source_sha256 FROM tender.required_documents r LEFT JOIN tender.enrichment_documents d ON d.id=r.source_document_id
          WHERE r.tender_id=$1 AND r.tender_version_id=$2 AND r.lot_key=$3 AND r.company_id=$4 AND r.satisfaction_status='MISSING' AND r.current_upload_id IS NULL FOR UPDATE OF r`,[context.tender_id,context.tender_version_id,context.lot_key,context.company_id])).rows;
        for(const requirement of existingMissing){
          const classification=classifyRequirementEvidence(requirement.requirement_description);
          if(!["POST_AWARD_EVIDENCE","CONTRACT_PERFORMANCE_CLAUSE"].includes(classification.classification))continue;
          await client.query(`UPDATE tender.required_documents SET requirement_classification=$2,classification_reason=$3,
            classification_provenance=$4::jsonb,mandatory=false,submission_relevant=false,satisfaction_status='NOT_REQUIRED',
            not_required_reason=$5,updated_at=now() WHERE id=$1`,[requirement.id,classification.classification,classification.reason,JSON.stringify({classifierVersion:"wb-bid-time-requirement/1.0.0",rule:classification.rule,deterministic:true,sourceDocumentId:requirement.source_document_id,sourceSha256:requirement.source_sha256,sourcePage:requirement.source_page}),`${classification.classification}: ${classification.reason}`]);
          await client.query("INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES(NULL,'REQUIRED_DOCUMENT_CLASSIFICATION_REPAIRED',$1,$2::jsonb)",[requirement.tender_id,JSON.stringify({requiredDocumentId:requirement.id,companyId:requirement.company_id,lotKey:requirement.lot_key,sourceDocumentId:requirement.source_document_id,sourceSha256:requirement.source_sha256,sourcePage:requirement.source_page,previousStatus:requirement.satisfaction_status,status:"NOT_REQUIRED",classification:classification.classification,rule:classification.rule,reason:classification.reason,automatedDeterministicRepair:true,externalWrite:false,transmitted:false})]);
        }
        if(Number(context.prior_schema_version||0)<7){
          await client.query("UPDATE tender.final_preflight_requirements SET status='SUPERSEDED',updated_at=now() WHERE context_id=$1",[saved.id]);
          await client.query("UPDATE tender.required_documents SET satisfaction_status='SUPERSEDED',updated_at=now() WHERE tender_id=$1 AND tender_version_id=$2 AND lot_key=$3 AND company_id=$4 AND source_type='TENDER_DOCUMENT' AND current_upload_id IS NULL AND satisfaction_status<>'NOT_REQUIRED'",[context.tender_id,context.tender_version_id,context.lot_key,context.company_id]);
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
          await client.query(`INSERT INTO tender.final_preflight_requirements(context_id,requirement_key,requirement_kind,title,description,source_type,source_document_id,source_page,source_reference,source_excerpt,source_evidence_sha256,scope_type,category,mandatory,submission_relevant,human_action_required,legal_confirmation_required,action_group,status,due_at,requirement_classification,classification_reason,classification_provenance)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb)
            ON CONFLICT(context_id,requirement_key,source_evidence_sha256) DO UPDATE SET title=excluded.title,description=excluded.description,due_at=excluded.due_at,status=excluded.status,requirement_classification=excluded.requirement_classification,classification_reason=excluded.classification_reason,classification_provenance=excluded.classification_provenance,updated_at=now()`,[saved.id,item.requirementKey,item.requirementKind,item.title,item.description,item.sourceType,item.sourceDocumentId,item.sourcePage,item.sourceReference,item.sourceExcerpt,item.sourceEvidenceSha256,item.scopeType,item.category,item.mandatory,item.submissionRelevant,item.humanActionRequired,item.legalConfirmationRequired,item.actionGroup,item.status,item.dueAt,item.requirementClassification,item.classificationReason,JSON.stringify(item.classificationProvenance)]);
          if(["REQUIRED_DOCUMENT","PORTAL_FORM"].includes(item.requirementKind)) await client.query(`INSERT INTO tender.required_documents(tender_id,tender_version_id,lot_key,company_id,requirement_code,requirement_title,requirement_description,source_document_id,source_page,source_reference,category,document_type,mandatory,submission_relevant,accepted_formats,max_file_size,satisfaction_status,source_type,reusable_company_evidence,requirement_classification,classification_reason,classification_provenance)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,ARRAY['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],20971520,'MISSING',$15,$14,$16,$17,$18::jsonb)
            ON CONFLICT(tender_id,tender_version_id,lot_key,company_id,requirement_code) DO UPDATE SET requirement_title=excluded.requirement_title,requirement_description=excluded.requirement_description,source_document_id=excluded.source_document_id,source_page=excluded.source_page,source_reference=excluded.source_reference,source_type=excluded.source_type,requirement_classification=excluded.requirement_classification,classification_reason=excluded.classification_reason,classification_provenance=excluded.classification_provenance,satisfaction_status=CASE WHEN tender.required_documents.satisfaction_status='SUPERSEDED' THEN 'MISSING' ELSE tender.required_documents.satisfaction_status END,updated_at=now()`,[context.tender_id,context.tender_version_id,context.lot_key,context.company_id,item.requirementKey,item.title,item.description,item.sourceDocumentId,item.sourcePage,item.sourceReference,item.category,item.mandatory,item.submissionRelevant,["INSURANCE","REGISTER","CERTIFICATE"].includes(item.category),item.requirementKind==="PORTAL_FORM"?"PORTAL_FORM":"TENDER_DOCUMENT",item.requirementClassification,item.classificationReason,JSON.stringify(item.classificationProvenance)]);
        }
        await client.query(`WITH matches AS(SELECT r.id,e.id evidence_id FROM tender.required_documents r JOIN tender.evidence_items e ON e.company_id=r.company_id
          WHERE r.tender_id=$1 AND r.tender_version_id=$2 AND r.lot_key=$3 AND r.company_id=$4 AND r.reusable_company_evidence
            AND r.satisfaction_status IN('MISSING','AVAILABLE') AND e.status IN('VERIFIED','VALIDATED','AVAILABLE') AND (e.valid_until IS NULL OR e.valid_until>=current_date)
            AND upper(e.evidence_type)=upper(r.category)),links AS(INSERT INTO tender.required_document_company_evidence_links(required_document_id,evidence_item_id,matched_by)
          SELECT id,evidence_id,'GENERIC_EXACT_COMPANY_AND_EVIDENCE_TYPE' FROM matches ON CONFLICT DO NOTHING)
          UPDATE tender.required_documents r SET satisfaction_status='VALIDATED',source_type='COMPANY_EVIDENCE',updated_at=now() WHERE r.id IN(SELECT id FROM matches)`,[context.tender_id,context.tender_version_id,context.lot_key,context.company_id]);
        await client.query(`UPDATE tender.final_preflight_requirements f SET status=r.satisfaction_status,manual_submission_relevance_override=r.manual_submission_relevance_override,requirement_classification=r.requirement_classification,classification_reason=r.classification_reason,classification_provenance=r.classification_provenance,mandatory=r.mandatory,submission_relevant=r.submission_relevant,updated_at=now() FROM tender.required_documents r
          WHERE f.context_id=$1 AND f.requirement_key=r.requirement_code AND r.tender_id=$2 AND r.tender_version_id=$3 AND r.lot_key=$4 AND r.company_id=$5
            AND r.satisfaction_status IN('MISSING','AVAILABLE','UPLOADED_PENDING_VALIDATION','MANUAL_REVIEW_REQUIRED','VALIDATED','REJECTED','NOT_REQUIRED','SUPERSEDED')`,[saved.id,context.tender_id,context.tender_version_id,context.lot_key,context.company_id]);
        requirementCount+=discovered.length;
        const requirements=(await client.query("SELECT * FROM tender.final_preflight_requirements WHERE context_id=$1 AND status<>'SUPERSEDED'",[saved.id])).rows,
          requiredDocumentsForReadiness=(await client.query(`SELECT r.id,r.requirement_title title,
            CASE WHEN r.satisfaction_status='MISSING' AND (coalesce(w.editor_provenance->>'materiallyEdited','false')='true' OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(w.overlay_data,'[]'::jsonb)) e WHERE e->>'type'='mark' OR (e->>'type'='checkbox' AND e->>'checked'='true') OR (e->>'type' IN('text','note') AND btrim(coalesce(e->>'text',''))<>''))) THEN 'MANUAL_REVIEW_REQUIRED' ELSE r.satisfaction_status END status,
            r.mandatory,r.submission_relevant,r.manual_submission_relevance_override,false human_action_required,'REQUIRED_DOCUMENT' requirement_kind
            FROM tender.required_documents r LEFT JOIN LATERAL(SELECT overlay_data,editor_provenance FROM tender.required_document_working_copies x WHERE x.required_document_id=r.id AND x.is_current LIMIT 1)w ON true
            WHERE r.tender_id=$1 AND r.tender_version_id=$2 AND r.lot_key=$3 AND r.company_id=$4 AND r.satisfaction_status<>'SUPERSEDED'`,[context.tender_id,context.tender_version_id,context.lot_key,context.company_id])).rows,
          allReadinessRequirements=[...requirements,...requiredDocumentsForReadiness];
        for(const requirement of requirements.filter(x=>x.human_action_required && x.manual_submission_relevance_override!==false && !["VALIDATED","NOT_REQUIRED"].includes(x.status))){
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
  const preflightTimer=readOnlyCandidate?null:setInterval(()=>reconcileFinalPreflight().catch((error)=>app.log.error({error:error.message},"generic final preflight reconciliation failed")),60000);
  preflightTimer?.unref?.();if(!readOnlyCandidate)setTimeout(()=>reconcileFinalPreflight().catch((error)=>app.log.error({error:error.message},"initial generic final preflight reconciliation failed")),2500).unref?.();
  app.addHook("onClose",async()=>{if(preflightTimer)clearInterval(preflightTimer)});
  app.get("/api/final-preflight/contexts",{preHandler:read},async(req)=>{
    const tenderId=String(req.query?.tenderId||"").trim();
    if(tenderId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenderId))return {items:[],transmitted:false,externalSubmission:false};
    const companyIds=req.identity.permissions.includes("tender.admin")?null:req.identity.companyIds;
    const rows=(await pool.query(`SELECT c.*,
      (SELECT status FROM tender.calculations calculation WHERE calculation.id=c.calculation_id) calculation_status,
      (SELECT status FROM tender.management_outputs management WHERE management.id=c.management_output_id) management_output_status,
      (SELECT status FROM tender.approval_requests approval WHERE approval.id=c.approval_request_id) approval_status,
      coalesce(jsonb_agg(jsonb_build_object('group',r.action_group,'title',r.title,'status',CASE WHEN r.manual_submission_relevance_override=false THEN 'MANUALLY_NOT_REQUIRED' WHEN r.status='MISSING' AND rd.satisfaction_status='MISSING' AND (coalesce(w.editor_provenance->>'materiallyEdited','false')='true' OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(w.overlay_data,'[]'::jsonb)) e WHERE e->>'type'='mark' OR (e->>'type'='checkbox' AND e->>'checked'='true') OR (e->>'type' IN('text','note') AND btrim(coalesce(e->>'text',''))<>''))) THEN 'MANUAL_REVIEW_REQUIRED' ELSE r.status END,'manualSubmissionRelevanceOverride',r.manual_submission_relevance_override,'source',r.source_reference,'page',r.source_page,'dueAt',r.due_at,'humanActionRequired',r.human_action_required)) FILTER(WHERE r.id IS NOT NULL),'[]'::jsonb) requirements
      FROM tender.current_final_preflight_contexts c JOIN tender.current_registered_tender_company_portals registered ON registered.tender_id=c.tender_id AND registered.company_id=c.company_id LEFT JOIN tender.final_preflight_requirements r ON r.context_id=c.id AND r.status<>'SUPERSEDED'
      LEFT JOIN tender.required_documents rd ON rd.tender_id=c.tender_id AND rd.company_id=c.company_id AND rd.lot_key=c.lot_key AND rd.requirement_code=r.requirement_key AND rd.source_document_id=r.source_document_id
      LEFT JOIN LATERAL(SELECT overlay_data,editor_provenance FROM tender.required_document_working_copies wc WHERE wc.required_document_id=rd.id AND wc.is_current LIMIT 1)w ON true
      WHERE ($1::uuid IS NULL OR c.tender_id=$1) AND ($2::uuid[] IS NULL OR c.company_id=ANY($2)) GROUP BY c.id,c.tender_id,c.tender_version_id,c.lot_key,c.company_id,c.service_line,c.document_revision_sha256,c.calculation_id,c.management_output_id,c.approval_request_id,c.bid_package_id,c.submission_context_id,c.portal_session_id,c.binding_valid,c.schema_version,c.schema_sha256,c.readiness_status,c.transmitted,c.is_current,c.discovered_at,c.created_at,c.updated_at,c.title,c.offer_deadline,c.company_name ORDER BY c.offer_deadline`,[tenderId||null,companyIds])).rows;
    return {items:rows,transmitted:false,externalSubmission:false};
  });
  app.get("/api/management/final-preflight-actions",{preHandler:read},async(req)=>{const companyIds=req.identity.permissions.includes("tender.admin")?null:req.identity.companyIds;return {items:(await pool.query(`SELECT a.id,a.display_title,a.instruction,a.priority,a.status,a.due_at,c.title tender_title,c.tender_id,c.lot_key,c.company_id,c.company_name,c.service_line,r.action_group,r.source_reference,r.source_page,p.display_name portal_name
      FROM tender.final_preflight_user_actions a JOIN tender.final_preflight_requirements r ON r.id=a.requirement_id JOIN tender.current_final_preflight_contexts c ON c.id=a.context_id JOIN tender.current_registered_tender_company_portals registered ON registered.tender_id=c.tender_id AND registered.company_id=c.company_id JOIN tender.portal_registry p ON p.id=registered.portal_id
      WHERE a.status IN('OPEN','IN_PROGRESS') AND r.status<>'SUPERSEDED' AND r.manual_submission_relevance_override IS DISTINCT FROM false AND ($1='' OR c.service_line=$1) AND ($2='' OR r.action_group=$2)
        AND ($3='' OR c.company_id::text=$3) AND ($4='' OR c.tender_id::text=$4) AND ($5='' OR c.lot_key=$5) AND ($6='' OR a.priority=$6) AND ($7::uuid[] IS NULL OR c.company_id=ANY($7))
      ORDER BY a.due_at NULLS LAST,a.priority DESC`,[String(req.query?.serviceLine||''),String(req.query?.blockerType||''),String(req.query?.company||''),String(req.query?.tender||''),String(req.query?.lot||''),String(req.query?.priority||''),companyIds])).rows};});
  const list = (path, permission, sql) =>
    app.get(path, { preHandler: requirePermission(permission) }, async () => ({
      items: (await pool.query(sql)).rows,
    }));
  const noticeLifecycles = async (tenderIds) => {
    if (!tenderIds.length) return new Map();
    const rows=(await pool.query(`SELECT t.id tender_id,t.external_id,t.notice_classification,t.source_lifecycle_status,t.participation_status,t.participation_block_reason,t.notice_type_code,t.notice_subtype,t.procedure_identifier,
      related.id original_tender_id,related.external_id original_external_id,related.offer_deadline original_offer_deadline,related.title original_title
      FROM tender.tenders t LEFT JOIN LATERAL(
        SELECT original.id,original.external_id,original.offer_deadline,original.title FROM tender.tender_notice_relationships relation
        JOIN tender.tenders original ON original.id=relation.related_tender_id
        WHERE relation.source_tender_id=t.id AND original.notice_classification IN('COMPETITION','CORRIGENDUM')
        ORDER BY original.publication_date DESC NULLS LAST LIMIT 1
      )related ON true WHERE t.id=ANY($1::uuid[])`,[tenderIds])).rows;
    return new Map(rows.map((row)=>{
      if(row.source_lifecycle_status==="ACTIVE"&&row.participation_status==="ELIGIBLE")return [String(row.tender_id),null];
      const labels={RESULT:"Ergebnisbekanntmachung",CONTRACT_MODIFICATION:"Auftragsänderung",CANCELLATION:"Aufhebung oder Widerruf",VOLUNTARY_EX_ANTE:"Freiwillige Ex-ante-Bekanntmachung",PRIOR_INFORMATION:"Vorinformation",UNKNOWN:"Klassifizierung zu prüfen",CORRIGENDUM:"Berichtigung"};
      return [String(row.tender_id),{
        status:row.source_lifecycle_status,statusLabel:row.notice_classification==="RESULT"?"Ergebnisbekanntmachung – Verfahren abgeschlossen":row.source_lifecycle_status==="REVIEW_REQUIRED"?"Fachliche Prüfung erforderlich":"Verfahren abgeschlossen",
        noticeType:row.notice_classification,noticeTypeLabel:labels[row.notice_classification]||row.notice_classification,
        resultLabel:row.notice_classification==="RESULT"?"Ergebnis veröffentlicht":"Keine Teilnahmeaktion",offerLabel:"Nicht möglich",
        calculationLabel:"Für diese Bekanntmachung nicht freigegeben",portalAccessLabel:"Für Teilnahmeaktionen nicht freigegeben",
        documentStatusLabel:"Historische Unterlagen bleiben unverändert erhalten",monitoringLabel:"Abgeschlossen / nur Historie",
        procedureId:row.procedure_identifier,noticeSubtype:row.notice_subtype,blockReason:row.participation_block_reason,
        original:row.original_tender_id?{tenderId:row.original_tender_id,noticeId:row.original_external_id,offerDeadline:row.original_offer_deadline,title:row.original_title}:null,
      }];
    }));
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
          `WITH latest_calculation AS (
             SELECT id FROM tender.calculations
             WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3
             ORDER BY version DESC,created_at DESC,id DESC LIMIT 1
           )
           SELECT m.id,m.calculation_id,m.profile_snapshot_id,m.document_revision,
                  m.management_output_version,m.output_sha256,m.status,m.payload,m.created_at
           FROM tender.management_outputs m
           JOIN latest_calculation c ON c.id=m.calculation_id
           WHERE m.tender_id=$1 AND m.company_id=$2 AND m.lot_key=$3
             AND m.scenario_key='REAL' AND m.historical=false
           ORDER BY m.created_at DESC,m.id DESC LIMIT 1`,
          [req.params.id, company.company_id, lotKey],
        ),
        pool.query(
          `WITH latest_calculation AS (
             SELECT id FROM tender.calculations
             WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3
             ORDER BY version DESC,created_at DESC,id DESC LIMIT 1
           )
           SELECT a.id,a.status,a.expires_at,a.created_at,a.payload_manifest,
                  a.payload_manifest->>'auditId' audit_id
           FROM tender.approval_requests a
           JOIN latest_calculation c ON c.id=a.calculation_id
           ORDER BY a.created_at DESC,a.id DESC LIMIT 1`,
          [req.params.id, company.company_id, lotKey],
        ),
        pool.query(
          `WITH latest_calculation AS (
             SELECT id,calculation_input_snapshot_id FROM tender.calculations
             WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3
             ORDER BY version DESC,created_at DESC,id DESC LIMIT 1
           ), exact_documents AS (
             SELECT fingerprint.value->>'documentId' document_id,
                    lower(fingerprint.value->>'sha256') sha256
             FROM latest_calculation calculation
             JOIN tender.calculation_input_snapshots snapshot
               ON snapshot.id=calculation.calculation_input_snapshot_id
             CROSS JOIN LATERAL jsonb_array_elements(snapshot.document_fingerprints) fingerprint(value)
           )
           SELECT DISTINCT ON(d.id) d.id,d.filename,d.source_url,d.payload_sha256,d.provenance
           FROM exact_documents exact
           JOIN tender.enrichment_documents d
             ON d.id::text=exact.document_id
            AND lower(d.payload_sha256)=exact.sha256
           JOIN tender.enrichment_versions e ON e.id=d.enrichment_version_id
           WHERE e.tender_id=$1
           ORDER BY d.id,d.created_at DESC`,
          [req.params.id, company.company_id, lotKey],
        ),
        pool.query(
          `WITH latest_calculation AS (
             SELECT id,tenant_id,tender_id,company_id,lot_key,calculation_input_snapshot_id
             FROM tender.calculations
             WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3
             ORDER BY version DESC,created_at DESC,id DESC LIMIT 1
           )
           SELECT snapshot.id,snapshot.snapshot_sha256,snapshot.contract_version,
                  snapshot.contract_state,snapshot.fact_records,snapshot.parameter_records,
                  snapshot.document_fingerprints,snapshot.rule_types
           FROM latest_calculation calculation
           JOIN tender.calculation_input_snapshots snapshot
             ON snapshot.id=calculation.calculation_input_snapshot_id
            AND snapshot.tenant_id=calculation.tenant_id
            AND snapshot.tender_id=calculation.tender_id
            AND snapshot.company_id=calculation.company_id
            AND snapshot.lot_key=coalesce(calculation.lot_key,'')`,
          [req.params.id, company.company_id, lotKey],
        ),
        pool.query(
          "SELECT id,title,buyer,source_code,offer_deadline,procurement_number,notice_number,external_id FROM tender.tenders WHERE id=$1",
          [req.params.id],
        ),
      ]);
      const calculation = calculationResult.rows[0],
        tender = tenderResult.rows[0],
        calculationInputSnapshot = snapshotResult.rows[0] || null;
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
        calculationInputSnapshot,
        snapshotId: calculationInputSnapshot?.id || null,
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
      if (!(await requireParticipationEligible(reply,req.params.id,req.body?.lotKey))) return;
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
    "/api/completed-procedures",
    {preHandler:read},
    async(req)=>{
      const companies=await accessibleCompanies(req.identity),companyIds=companies.map((row)=>row.company_id),pageSize=Math.max(1,Math.min(100,Number(req.query?.pageSize)||50)),page=Math.max(1,Number(req.query?.page)||1),offset=(page-1)*pageSize;
      if(!companyIds.length)return {items:[],total:0,page,pageSize,hasMore:false};
      const params=[companyIds,pageSize+1,offset,String(req.query?.q||"").slice(0,200)];
      const result=await pool.query(`WITH scoped AS(
        SELECT DISTINCT ON(t.id,relevance.company_id) t.*,relevance.company_id,company.legal_name company_name,relevance.service_line,relevance.lot_key
        FROM tender.tenders t JOIN tender.current_service_relevance relevance ON relevance.tender_id=t.id AND relevance.company_id=ANY($1::uuid[])
        JOIN tender.enterprise_company_links company ON company.company_id=relevance.company_id
        WHERE t.data_class='PUBLIC_REAL' AND (t.source_lifecycle_status IN('CLOSED','WITHDRAWN') OR t.notice_classification IN('RESULT','CONTRACT_MODIFICATION','CANCELLATION','VOLUNTARY_EX_ANTE'))
          AND ($4='' OR t.search_document@@plainto_tsquery('german',$4))
        ORDER BY t.id,relevance.company_id,relevance.evaluation_version DESC
      ) SELECT scoped.*,count(*) OVER()::int total_count,original.id original_tender_id,original.external_id original_external_id,original.title original_title
        FROM scoped LEFT JOIN LATERAL(SELECT related.id,related.external_id,related.title FROM tender.tender_notice_relationships relation JOIN tender.tenders related ON related.id=relation.related_tender_id WHERE relation.source_tender_id=scoped.id AND related.notice_classification IN('COMPETITION','CORRIGENDUM') ORDER BY related.publication_date DESC NULLS LAST LIMIT 1)original ON true
        ORDER BY scoped.publication_date DESC NULLS LAST,scoped.id LIMIT $2 OFFSET $3`,params);
      const rows=result.rows,total=Number(rows[0]?.total_count||0);return {items:rows.slice(0,pageSize),total,page,pageSize,hasMore:rows.length>pageSize,externalActions:false};
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
          `WITH candidates AS(SELECT r.*,t.title,t.external_id,t.notice_number,t.procurement_number,t.ted_id,t.buyer,t.cpv_codes,t.source_code,t.source_url,t.regions,t.offer_deadline,t.created_at tender_created_at,c.legal_name,
        EXISTS(SELECT 1 FROM tender.current_registered_tender_company_portals registered WHERE registered.tender_id=r.tender_id AND registered.company_id=r.company_id) portal_scope_registered,
        row_number() OVER(PARTITION BY r.tender_id,r.lot_key ORDER BY r.primary_company DESC,r.relevance_status,r.company_id) canonical_rank,
        bool_or(r.primary_company) OVER(PARTITION BY r.tender_id,r.lot_key) has_primary
      FROM tender.current_service_relevance r
      JOIN tender.tenders t ON t.id=r.tender_id JOIN tender.enterprise_company_links c ON c.company_id=r.company_id
      WHERE r.company_id=ANY($1::uuid[]) AND t.data_class='PUBLIC_REAL' AND t.source_lifecycle_status='ACTIVE' AND t.participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE') AND EXISTS(SELECT 1 FROM tender.current_participation_eligible_lots eligible WHERE eligible.tender_id=t.id))
      SELECT rm.tender_id,rm.title,rm.external_id,rm.notice_number,rm.procurement_number,rm.ted_id,rm.buyer,rm.cpv_codes,rm.source_code,rm.source_url,rm.portal_scope_registered,rm.company_id,CASE WHEN rm.primary_company THEN rm.legal_name ELSE 'Keine' END company,
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
      const participationEligible=tender.source_lifecycle_status==="ACTIVE"&&tender.participation_status==="ELIGIBLE"&&tender.offer_deadline&&new Date(tender.offer_deadline)>new Date();
      const registeredScope = participationEligible?await requireRegisteredScope(reply, tender.id, company.company_id):null;
      if (participationEligible&&!registeredScope) return;
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
            "SELECT id,lot_id enrichment_lot_id,document_type,filename,fetch_status,resolution_status,http_status,mime_type,payload_sha256,parser,parser_version,retrieved_at,provenance,extracted_data FROM tender.enrichment_documents WHERE enrichment_version_id=$1 ORDER BY filename NULLS LAST",
              [enrichmentId],
            )
          : Promise.resolve({ rows: [] }),
        enrichmentId
          ? pool.query(
            "SELECT lot_id enrichment_lot_id,field_key,value,quality_status,provenance,confidence,created_at FROM tender.enrichment_fields WHERE enrichment_version_id=$1 ORDER BY field_key",
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
          `SELECT d.id,d.lot_id enrichment_lot_id,el.lot_key document_lot_key,d.document_type,d.filename,d.fetch_status,d.resolution_status,
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
            AND satisfaction_status NOT IN('VALIDATED','NOT_REQUIRED','SUPERSEDED') AND manual_submission_relevance_override IS DISTINCT FROM false ORDER BY requirement_title`,
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
  app.get("/api/profiles",{preHandler:read},async(req)=>{
    const companies=req.identity.permissions.includes("tender.admin")?(await pool.query("SELECT company_id,legal_name,sector_slug FROM tender.enterprise_company_links WHERE active=true ORDER BY legal_name")).rows:await accessibleCompanies(req.identity),ids=companies.map(x=>x.company_id);
    if(!ids.length)return {items:[],groups:[],fieldDefinitions:profileFieldDefinitions,sourceTypes:profileSourceTypeLabels};
    const rows=(await pool.query(`SELECT p.*,c.legal_name,scope.canonical_service,
      CASE scope.canonical_service WHEN 'facility_management' THEN 'facility-management' WHEN 'emergency_services' THEN 'emergency-services' ELSE scope.canonical_service END service_line
      FROM tender.company_profiles p JOIN tender.enterprise_company_links c ON c.company_id=p.company_id
      LEFT JOIN tender.configuration_scopes scope ON scope.company_id=p.company_id AND scope.profile_id=c.tender_profile_id
      WHERE p.company_id=ANY($1::uuid[]) ORDER BY c.legal_name,p.version DESC`,[ids])).rows;
    const latest=new Map();for(const row of rows)if(!latest.has(`${row.company_id}:${row.service_line}`))latest.set(`${row.company_id}:${row.service_line}`,row.id);
    const canEdit=req.identity.permissions.includes("tender.admin")||req.identity.permissions.some(x=>["tender.config.draft.edit","tender.config.services.edit","tender.config.evidence.edit","tender.config.regions.edit","tender.config.costs.edit"].includes(x));
    const items=rows.map(row=>{const completion=evaluateProfile(row),current=latest.get(`${row.company_id}:${row.service_line}`)===row.id,editable=current&&["DRAFT","READY_FOR_APPROVAL"].includes(row.lifecycle_status)&&!row.approved_at&&canEdit;return {...row,...completion,current,editable,history:!current,nextStep:completion.releaseReady?"Vorhandenen Freigabeprozess starten":`${completion.missingValues} fehlende Werte und ${completion.missingSources} Quellen bearbeiten`}});
    const groups=[...new Set(items.map(x=>`${x.company_id}:${x.service_line}`))].map(key=>{const versions=items.filter(x=>`${x.company_id}:${x.service_line}`===key);return {companyId:versions[0].company_id,company:versions[0].legal_name,serviceLine:versions[0].service_line,current:versions.find(x=>x.current),history:versions.filter(x=>!x.current)}});
    return {items,groups,fieldDefinitions:profileFieldDefinitions,sourceTypes:profileSourceTypeLabels};
  });
  app.put("/api/profiles/:id/fields/:fieldKey",{preHandler:[requirePermission(["tender.config.draft.edit","tender.config.services.edit","tender.config.evidence.edit","tender.config.regions.edit","tender.config.costs.edit"]),csrf…88475 tokens truncated…ing && !preparation.ready)
        return reply.code(409).send({ error: "internal_preparation_prerequisites_missing", message: "Die interne Vorbereitung kann erst nach Abschluss aller Voraussetzungen angelegt werden.", preparation, externalSubmission: false, transmitted: false });
      const source = (
        await pool.query(
          `SELECT package.*,calculation.company_id,management.management_output_version,tender.offer_deadline,approval.id approval_request_id,approval.status approval_status,approval.payload_sha256,portal.id portal_id,portal.adapter_id portal_code,cap.portal_support,cap.autopilot_supported,
      credential.id credential_id,credential.account_confirmed,access_grant.id submission_grant_id,access_grant.scope submission_grant_scope,session.id portal_session_id,session.status session_status,session.expires_at session_expires_at,session.verification_status session_verification_status,session.session_effective_status
      FROM tender.bid_packages package JOIN tender.calculations calculation ON calculation.id=package.calculation_id JOIN tender.management_outputs management ON management.id=package.management_output_id JOIN tender.tenders tender ON tender.id=package.tender_id
      JOIN tender.bid_submission_gates gate ON gate.bid_package_id=package.id JOIN tender.approval_requests approval ON approval.id=gate.approval_request_id JOIN tender.portal_adapters adapter ON adapter.id=package.portal_adapter_id JOIN tender.portal_registry portal ON portal.adapter_id=adapter.portal_code
      LEFT JOIN tender.current_portal_capability_truth cap ON cap.portal_family_key=portal.portal_family_key AND cap.feature_key='SUBMISSION'
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
      const adapter = submissionAdapterFor(source.portal_code),
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
      if (!(await requireParticipationEligible(reply,req.params.id,req.body?.lotKey))) return;
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
        genericReadiness = (await pool.query(`SELECT c.id,c.readiness_status,c.binding_valid,coalesce(jsonb_agg(jsonb_build_object('id',r.id,'requirementKey',r.requirement_key,'code',r.requirement_kind,'title',r.title,'status',CASE WHEN r.status='MISSING' AND rd.satisfaction_status='MISSING' AND (coalesce(w.editor_provenance->>'materiallyEdited','false')='true' OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(w.overlay_data,'[]'::jsonb)) e WHERE e->>'type'='mark' OR (e->>'type'='checkbox' AND e->>'checked'='true') OR (e->>'type' IN('text','note') AND btrim(coalesce(e->>'text',''))<>''))) THEN 'MANUAL_REVIEW_REQUIRED' ELSE r.status END,'source',r.source_reference,'page',r.source_page,'sourceDocumentId',r.source_document_id)) FILTER(WHERE r.id IS NOT NULL AND r.submission_relevant AND r.mandatory AND r.manual_submission_relevance_override IS DISTINCT FROM false AND r.status NOT IN('VALIDATED','NOT_REQUIRED','SUPERSEDED')),'[]'::jsonb) open_requirements
          FROM tender.final_preflight_contexts c LEFT JOIN tender.final_preflight_requirements r ON r.context_id=c.id
          LEFT JOIN tender.required_documents rd ON rd.tender_id=c.tender_id AND rd.company_id=c.company_id AND rd.lot_key=c.lot_key AND rd.requirement_code=r.requirement_key AND rd.source_document_id=r.source_document_id
          LEFT JOIN LATERAL(SELECT overlay_data,editor_provenance FROM tender.required_document_working_copies wc WHERE wc.required_document_id=rd.id AND wc.is_current LIMIT 1)w ON true
          WHERE c.tender_id=$1 AND c.company_id=$2 AND c.lot_key=$3 AND c.is_current GROUP BY c.id`,[req.params.id,companyId,lotKey])).rows[0],
        preflight = evaluateEnterprisePreflight({
          managementApprovalValid: context.management_approval_valid === true,
          bidPackageReady:
            context.bid_package_status === "BID_PACKAGE_READY_FOR_SUBMISSION",
          portalSupportsSubmission:
            context.submission_portal_support === "SUPPORTED",
          autopilotSupportsSubmission:
            context.submission_autopilot_supported === true &&
            submissionAdapterFor(context.portal_code).productionValidated ===
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
        for(const requirement of requiredDocuments.filter(x=>x.mandatory&&x.submission_relevant&&x.manual_submission_relevance_override!==false&&!["VALIDATED","NOT_REQUIRED","SUPERSEDED"].includes(x.satisfaction_status)))
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
    { preHandler: [requirePermission("tender.calculation.sandbox"), csrf] },
    async (req) => ({
      result: calculateScenario(req.body?.input || {}, req.body?.config || {}),
      sensitivity: sensitivity(req.body?.input || {}, req.body?.config || {}),
      sandbox: true,
      persisted: false,
      externalTransmission: false,
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
    const items=await requiredDocumentContext(req.params.id,companyId,lotKey),missing=items.filter(isRequiredDocumentMissing),blockers=items.filter(isRequiredDocumentBlocker);
    return {items,summary:{total:items.length,missing:missing.length,blockers:blockers.length,available:items.filter(x=>x.satisfaction_status==="AVAILABLE").length,uploaded:items.filter(x=>x.current_upload_id).length,validated:items.filter(x=>x.satisfaction_status==="VALIDATED").length,manualReview:items.filter(x=>x.satisfaction_status==="MANUAL_REVIEW_REQUIRED").length,rejected:items.filter(x=>x.satisfaction_status==="REJECTED").length,complete:items.length>0&&blockers.length===0,discoveryComplete:items.length>0},transmitted:false};
  });
  app.post("/api/tenders/:id/required-documents/:requiredDocumentId/submission-relevance",{preHandler:[requirePermission("tender.document.analyze"),csrf]},async(req,reply)=>{
    if(!(await visibleTender(req,reply,req.params.id)))return;
    if(!(await requireParticipationEligible(reply,req.params.id,req.body?.lot)))return;
    const companyId=String(req.body?.company||""),lotKey=String(req.body?.lot??""),decision=String(req.body?.decision||"");
    if(!validUuid(req.params.id)||!validUuid(req.params.requiredDocumentId)||!validUuid(companyId)||!["REQUIRED","NOT_REQUIRED"].includes(decision))return reply.code(400).send({error:"required_document_submission_relevance_contract_invalid"});
    if(!req.identity.permissions.includes("tender.admin")&&!req.identity.companyIds.includes(companyId))return reply.code(403).send({error:"company_scope_forbidden"});
    if(!(await requireRegisteredScope(reply,req.params.id,companyId)))return;
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      const previous=(await client.query("SELECT * FROM tender.required_documents WHERE id=$1 AND tender_id=$2 AND company_id=$3 AND lot_key=$4 FOR UPDATE",[req.params.requiredDocumentId,req.params.id,companyId,lotKey])).rows[0];
      if(!previous){await client.query("ROLLBACK");return reply.code(404).send({error:"required_document_not_found"})}
      if(!previous.mandatory||!previous.submission_relevant||["NOT_REQUIRED","SUPERSEDED"].includes(previous.satisfaction_status)){await client.query("ROLLBACK");return reply.code(409).send({error:"required_document_submission_relevance_state_invalid"})}
      const wasExcluded=previous.manual_submission_relevance_override===false,nextOverride=decision==="NOT_REQUIRED"?false:null,changed=wasExcluded!== (nextOverride===false),decisionAt=new Date().toISOString();
      const requirement=changed?(await client.query(`UPDATE tender.required_documents SET manual_submission_relevance_override=$2,
        manual_submission_relevance_override_at=CASE WHEN $2::boolean=false THEN now() ELSE NULL END,
        manual_submission_relevance_override_by=CASE WHEN $2::boolean=false THEN $3 ELSE NULL END,updated_at=now()
        WHERE id=$1 RETURNING *`,[previous.id,nextOverride,req.identity.userId])).rows[0]:previous;
      const action=changed?(nextOverride===false?"REQUIRED_DOCUMENT_MANUALLY_EXCLUDED_FROM_SUBMISSION":"REQUIRED_DOCUMENT_MANUAL_SUBMISSION_EXCLUSION_RESTORED"):"REQUIRED_DOCUMENT_SUBMISSION_RELEVANCE_CONFIRMED_UNCHANGED";
      await client.query("INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,$2,$3,$4::jsonb)",[req.identity.userId,action,previous.tender_id,JSON.stringify({requiredDocumentId:previous.id,companyId:previous.company_id,lotKey:previous.lot_key,previousStatus:previous.satisfaction_status,previousClassification:previous.requirement_classification||null,previousManualSubmissionRelevanceOverride:previous.manual_submission_relevance_override??null,decision,answer:decision==="REQUIRED"?"Ja":"Nein",decisionAt,reason:"MANUAL_BID_SUBMISSION_RELEVANCE_OVERRIDE",source:"MANUAL_BID_SUBMISSION_RELEVANCE_OVERRIDE",changed,externalWrite:false,transmitted:false})]);
      const recheck=await runRequiredDocumentRecheck(client,requirement,null,req.identity.userId);
      await client.query("COMMIT");
      return {requiredDocumentId:requirement.id,decision,changed,bidSubmissionRelevanceState:requirement.manual_submission_relevance_override===false?"MANUALLY_NOT_REQUIRED":"REQUIRED",status:requirement.satisfaction_status,statusLabel:requirement.manual_submission_relevance_override===false?"Manuell als für die Angebotsabgabe nicht erforderlich bestätigt":requirementLabel(requirement.satisfaction_status),recheck,transmitted:false};
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
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
    const row=(await pool.query(`SELECT r.*,d.id original_document_id,d.filename original_filename,d.mime_type original_mime_type,d.payload_sha256 original_sha256,d.content original_content,d.procurement_verification_status original_verification_status,d.provenance original_provenance,v.version original_document_version,v.tender_id original_tender_id,scan.status original_malware_scan_status
      FROM tender.required_documents r LEFT JOIN tender.enrichment_documents d ON d.id=r.source_document_id LEFT JOIN tender.enrichment_versions v ON v.id=d.enrichment_version_id
      LEFT JOIN tender.document_malware_scans scan ON scan.document_id=d.id AND scan.payload_sha256=d.payload_sha256
      WHERE r.id=$1 AND r.tender_id=$2 AND r.company_id=$3 AND r.lot_key=$4`,[req.params.requiredDocumentId,req.params.id,companyId,lotKey])).rows[0];
    if(!row){reply.code(404).send({error:"required_document_not_found"});return null}
    const form=await resolveRequiredOriginalForm(row,row.original_document_id?[{id:row.original_document_id,tender_id:row.original_tender_id,company_id:row.company_id,lot_key:row.lot_key,filename:row.original_filename,mime_type:row.original_mime_type,payload_sha256:row.original_sha256,content:row.original_content,procurement_verification_status:row.original_verification_status,document_version:row.original_document_version,explicit_form_mapping:hasExactOriginalFormProvenance(row,row.original_provenance)}]:[]);
    if(!form.downloadable){reply.code(409).send({error:"original_form_mapping_not_proven",mappingStatus:form.status,message:form.status==="AMBIGUOUS_MAPPING"?"Die Zuordnung ist mehrdeutig und muss fachlich geprüft werden.":"Zu dieser Anforderung ist kein eindeutig belegtes Originalformular zugeordnet."});return null}
    return {row,form,companyId,lotKey};
  };
  const sendScopedFile=(reply,{content,mimeType,filename,inline=false})=>reply
    .header("content-type",mimeType).header("content-disposition",`${inline?"inline":"attachment"}; filename*=UTF-8''${encodeURIComponent(safeOriginalFilename(filename))}`)
    .header("x-content-type-options","nosniff").header("cache-control","private, no-store").header("content-security-policy","sandbox").send(content);
  const requiredSourceContext=async(req,reply)=>{
    if(!(await visibleTender(req,reply,req.params.id)))return null;
    const companyId=String(req.query?.company||req.body?.company||""),lotKey=String(req.query?.lot??req.body?.lot??"");
    if(!validUuid(req.params.requiredDocumentId)||!validUuid(companyId)){
      reply.code(400).send({error:"required_document_context_invalid",message:"Ausschreibung, Gesellschaft und Anforderung müssen eindeutig gewählt sein."});return null;
    }
    if(!req.identity.permissions.includes("tender.admin")&&!req.identity.companyIds.includes(companyId)){
      reply.code(403).send({error:"company_scope_forbidden"});return null;
    }
    if(!(await requireRegisteredScope(reply,req.params.id,companyId)))return null;
    const row=(await pool.query(`SELECT r.*,d.id source_id,d.filename source_filename,d.mime_type source_mime_type,d.payload_sha256 source_sha256,d.content source_content,v.version source_document_version,v.tender_id source_tender_id,scan.status source_malware_scan_status
      FROM tender.required_documents r
      JOIN tender.enrichment_documents d ON d.id=r.source_document_id
      JOIN tender.enrichment_versions v ON v.id=d.enrichment_version_id AND v.tender_id=r.tender_id
      LEFT JOIN tender.document_malware_scans scan ON scan.document_id=d.id AND scan.payload_sha256=d.payload_sha256
      WHERE r.id=$1 AND r.tender_id=$2 AND r.company_id=$3 AND r.lot_key=$4 AND r.satisfaction_status<>'SUPERSEDED'`,[req.params.requiredDocumentId,req.params.id,companyId,lotKey])).rows[0];
    if(!row){reply.code(404).send({error:"required_source_document_not_found"});return null}
    if(row.source_malware_scan_status!=="CLEAN"){reply.code(423).send({error:"source_document_quarantined",scanStatus:row.source_malware_scan_status||"PENDING"});return null}
    const source=resolveRequiredSourceDocument(row,[{id:row.source_id,tender_id:row.source_tender_id,required_document_id:row.id,company_id:row.company_id,lot_key:row.lot_key,filename:row.source_filename,mime_type:row.source_mime_type,payload_sha256:row.source_sha256,content:row.source_content,document_version:row.source_document_version}]);
    if(!source.available){reply.code(404).send({error:"required_source_document_not_found"});return null}
    return {...source,row,companyId,lotKey};
  };
  const requiredPdfSourceContext=async(req,reply)=>{
    const source=await requiredSourceContext(req,reply);if(!source)return null;
    const classification=source.row.requirement_classification?source.row.requirement_classification:classifyRequirementEvidence(source.row.requirement_description).classification;
    if(classification!=="FILLABLE_BIDDER_FORM"){reply.code(409).send({error:"required_document_not_fillable",classification,message:"Die PDF-Bearbeitung ist ausschließlich für eindeutig ausfüllbare Bieterformulare verfügbar."});return null}
    if(source.mimeType!=="application/pdf"){reply.code(409).send({error:"required_source_not_pdf",message:"Die universelle Bildschirmbearbeitung ist für PDF-Quellen verfügbar."});return null}
    const actualSha256=crypto.createHash("sha256").update(source.candidate.content).digest("hex");
    if(actualSha256!==source.sha256){reply.code(409).send({error:"required_source_integrity_mismatch"});return null}
    let pdf;try{pdf=await inspectPdfForOverlay(source.candidate.content)}catch(error){reply.code(409).send({error:error.message});return null}
    return {...source,pdf};
  };
  const requiredOfficeSourceContext=async(req,reply)=>{
    const context=await requiredOriginalContext(req,reply);if(!context)return null;
    const classification=context.row.requirement_classification?context.row.requirement_classification:classifyRequirementEvidence(context.row.requirement_description).classification;
    if(classification!=="FILLABLE_BIDDER_FORM"){reply.code(409).send({error:"required_document_not_fillable",classification,message:"Die Office-Bearbeitung ist ausschließlich für eindeutig ausfüllbare Bieterformulare verfügbar."});return null}
    if(![DOCX_MIME,XLSX_MIME].includes(context.form.mimeType)){reply.code(409).send({error:"required_source_not_office",message:"Dieser Bearbeitungspfad unterstützt ausschließlich exakt belegte DOCX- und XLSX-Formulare."});return null}
    if(context.row.original_malware_scan_status!=="CLEAN"){reply.code(423).send({error:"source_document_quarantined",scanStatus:context.row.original_malware_scan_status||"PENDING"});return null}
    const actualSha256=crypto.createHash("sha256").update(context.form.candidate.content).digest("hex");
    if(actualSha256!==context.form.sha256){reply.code(409).send({error:"required_source_integrity_mismatch"});return null}
    let inspection;try{inspection=await inspectOfficeForm(context.form.candidate.content,context.form.mimeType)}catch(error){reply.code(409).send({error:error.message});return null}
    if(!inspection.editable){reply.code(409).send({error:"office_form_structured_fields_missing",message:"Das Original enthält keine eindeutig strukturierten Formularfelder; eine freie, möglicherweise zerstörerische Bearbeitung bleibt gesperrt."});return null}
    return {...context,inspection};
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
  app.post("/api/tenders/:id/required-documents/:requiredDocumentId/working-copy/office",{bodyLimit:1_000_000,preHandler:[requirePermission("tender.document.analyze"),csrf]},async(req,reply)=>{
    const context=await requiredOfficeSourceContext(req,reply);if(!context)return;
    if(!(await requireParticipationEligible(reply,req.params.id,context.lotKey)))return;
    const source=context.form.candidate,filename=safeOriginalFilename(`Arbeitskopie-${source.filename}`),sha256=crypto.createHash("sha256").update(source.content).digest("hex"),client=await pool.connect();
    try{await client.query("BEGIN");await client.query("SELECT id FROM tender.required_documents WHERE id=$1 AND tender_id=$2 AND company_id=$3 AND lot_key=$4 FOR UPDATE",[context.row.id,context.row.tender_id,context.companyId,context.lotKey]);
      const existing=(await client.query("SELECT id,version,filename,media_type,sha256 FROM tender.required_document_working_copies WHERE required_document_id=$1 AND tender_id=$2 AND company_id=$3 AND lot_key=$4 AND source_sha256=$5 AND is_current FOR UPDATE",[context.row.id,context.row.tender_id,context.companyId,context.lotKey,context.form.sha256])).rows[0];
      if(existing){await client.query("COMMIT");return {item:existing,idempotent:true,editorType:"OFFICE",transmitted:false}}
      await client.query("UPDATE tender.required_document_working_copies SET is_current=false WHERE required_document_id=$1 AND is_current",[context.row.id]);
      const version=Number((await client.query("SELECT coalesce(max(version),0)+1 version FROM tender.required_document_working_copies WHERE required_document_id=$1",[context.row.id])).rows[0].version),provenance={kind:"REQUIRED_SOURCE_OFFICE",format:context.inspection.format,requiredDocumentId:context.row.id,sourceDocumentId:context.form.documentId,sourceSha256:context.form.sha256,sourceDocumentVersion:context.form.documentVersion||null,structuredFieldCount:context.inspection.structuredFieldCount,materiallyEdited:false,rereadVerified:true},item=(await client.query(`INSERT INTO tender.required_document_working_copies(required_document_id,tender_id,lot_key,company_id,source_document_id,source_sha256,version,filename,media_type,content,sha256,overlay_data,editor_provenance,prepared_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'[]'::jsonb,$12::jsonb,$13) RETURNING id,version,filename,media_type,sha256`,[context.row.id,context.row.tender_id,context.row.lot_key,context.row.company_id,context.form.documentId,context.form.sha256,version,filename,context.form.mimeType,source.content,sha256,JSON.stringify(provenance),req.identity.userId])).rows[0];
      await client.query("INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'REQUIRED_OFFICE_WORKING_COPY_PREPARED',$2,$3::jsonb)",[req.identity.userId,context.row.tender_id,JSON.stringify({...provenance,workingCopyId:item.id,version,companyId:context.row.company_id,lotKey:context.row.lot_key,originalUnchanged:true,externalWrite:false,transmitted:false})]);
      await client.query("COMMIT");return reply.code(201).send({item,idempotent:false,editorType:"OFFICE",transmitted:false});
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
  });
  app.get("/api/tenders/:id/required-documents/:requiredDocumentId/working-copy/office/fields",{preHandler:read},async(req,reply)=>{
    const context=await requiredOfficeSourceContext(req,reply);if(!context)return;
    const row=(await pool.query("SELECT id,version,content,media_type,filename,sha256,source_sha256,editor_provenance FROM tender.required_document_working_copies WHERE required_document_id=$1 AND tender_id=$2 AND company_id=$3 AND lot_key=$4 AND is_current",[context.row.id,context.row.tender_id,context.companyId,context.lotKey])).rows[0];
    if(!row)return reply.code(404).send({error:"working_copy_not_found"});if(![DOCX_MIME,XLSX_MIME].includes(row.media_type))return reply.code(409).send({error:"working_copy_not_office"});
    let inspection;try{inspection=await inspectOfficeForm(row.content,row.media_type)}catch(error){return reply.code(409).send({error:error.message})}
    return {item:{id:row.id,version:row.version,filename:row.filename,mediaType:row.media_type,format:inspection.format,sha256:row.sha256,sourceSha256:row.source_sha256,fields:inspection.fields,structuredFieldCount:inspection.structuredFieldCount},scope:{tenderId:context.row.tender_id,companyId:context.companyId,lotKey:context.lotKey,requiredDocumentId:context.row.id},editorType:"OFFICE",structuredPreview:true,visualReviewRequired:true,originalUnchanged:true,externalWrite:false,transmitted:false};
  });
  app.post("/api/tenders/:id/required-documents/:requiredDocumentId/working-copy/office/fields",{bodyLimit:1_000_000,preHandler:[requirePermission("tender.document.analyze"),csrf]},async(req,reply)=>{
    const context=await requiredOfficeSourceContext(req,reply);if(!context)return;if(!(await requireParticipationEligible(reply,req.params.id,context.lotKey)))return;
    const baseVersion=Number(req.body?.baseVersion),values=req.body?.fields;if(!Number.isInteger(baseVersion)||baseVersion<1)return reply.code(400).send({error:"working_copy_version_invalid"});
    const client=await pool.connect();try{await client.query("BEGIN");const current=(await client.query("SELECT * FROM tender.required_document_working_copies WHERE required_document_id=$1 AND tender_id=$2 AND company_id=$3 AND lot_key=$4 AND is_current FOR UPDATE",[context.row.id,context.row.tender_id,context.companyId,context.lotKey])).rows[0];
      if(!current){await client.query("ROLLBACK");return reply.code(404).send({error:"working_copy_not_found"})}if(Number(current.version)!==baseVersion){await client.query("ROLLBACK");return reply.code(409).send({error:"working_copy_version_conflict",currentVersion:current.version,message:"Die Arbeitskopie wurde zwischenzeitlich geändert. Bitte neu laden."})}
      if(![DOCX_MIME,XLSX_MIME].includes(current.media_type)||current.source_document_id!==context.form.documentId||current.source_sha256!==context.form.sha256){await client.query("ROLLBACK");return reply.code(409).send({error:"required_source_binding_mismatch"})}
      let before,filled;try{before=await inspectOfficeForm(current.content,current.media_type);filled=await fillOfficeForm(current.content,current.media_type,values)}catch(error){await client.query("ROLLBACK");return reply.code(400).send({error:error.message,message:"Die Office-Feldwerte sind ungültig."})}
      const beforeValues=new Map(before.fields.map(field=>[field.id,String(field.value??"")])),changedFields=filled.fields.filter(field=>beforeValues.get(field.id)!==String(field.value??"")).map(field=>field.id);
      if(!changedFields.length){await client.query("COMMIT");return {item:{id:current.id,version:current.version,filename:current.filename,media_type:current.media_type,sha256:current.sha256},idempotent:true,materiallyEdited:Boolean(current.editor_provenance?.materiallyEdited),rereadVerified:true,externalWrite:false,transmitted:false}}
      const scan=await scanBuffer(filled.content);if(scan.status!=="CLEAN"){await client.query("ROLLBACK");return reply.code(scan.status==="INFECTED"?422:503).send({error:scan.status==="INFECTED"?"document_rejected_malware":"malware_scanner_temporarily_unavailable",retryable:scan.status==="SCAN_ERROR"})}
      const version=Number((await client.query("SELECT coalesce(max(version),0)+1 version FROM tender.required_document_working_copies WHERE required_document_id=$1",[context.row.id])).rows[0].version),provenance={...(current.editor_provenance||{}),kind:"REQUIRED_SOURCE_OFFICE",baseVersion,materiallyEdited:true,rereadVerified:true,changedFields};
      await client.query("UPDATE tender.required_document_working_copies SET is_current=false WHERE id=$1",[current.id]);
      const item=(await client.query(`INSERT INTO tender.required_document_working_copies(required_document_id,tender_id,lot_key,company_id,source_document_id,source_sha256,version,filename,media_type,content,sha256,overlay_data,editor_provenance,prepared_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'[]'::jsonb,$12::jsonb,$13) RETURNING id,version,filename,media_type,sha256`,[context.row.id,context.row.tender_id,context.row.lot_key,context.row.company_id,context.form.documentId,context.form.sha256,version,current.filename,current.media_type,filled.content,filled.sha256,JSON.stringify(provenance),req.identity.userId])).rows[0];
      await client.query("UPDATE tender.required_document_uploads SET is_current=false WHERE required_document_id=$1 AND is_current",[context.row.id]);const uploadVersion=Number((await client.query("SELECT coalesce(max(version),0)+1 version FROM tender.required_document_uploads WHERE required_document_id=$1",[context.row.id])).rows[0].version),upload=(await client.query(`INSERT INTO tender.required_document_uploads(required_document_id,tender_id,lot_key,company_id,version,filename,media_type,size_bytes,sha256,content,source_type,source_working_copy_id,validation_status,validation_summary,validation_details,malware_scan_status,uploaded_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'REQUIRED_OFFICE_WORKING_COPY',$11,'MANUAL_REVIEW_REQUIRED',$12,$13::jsonb,'CLEAN',$14) RETURNING *`,[context.row.id,context.row.tender_id,context.row.lot_key,context.row.company_id,uploadVersion,current.filename,current.media_type,filled.sizeBytes,filled.sha256,filled.content,item.id,"Ausgefüllte Office-Arbeitskopie gespeichert und technisch wieder eingelesen – visuelle und fachliche Prüfung erforderlich.",JSON.stringify({origin:"VERSIONED_REQUIRED_OFFICE_WORKING_COPY",workingCopyId:item.id,workingCopyVersion:version,sourceSha256:context.form.sha256,rereadVerified:true,changedFields,automaticVisualCompletenessProven:false}),req.identity.userId])).rows[0];
      const requirement=(await client.query("UPDATE tender.required_documents SET current_upload_id=$2,satisfaction_status=CASE WHEN satisfaction_status='NOT_REQUIRED' THEN satisfaction_status ELSE 'MANUAL_REVIEW_REQUIRED' END,updated_at=now() WHERE id=$1 RETURNING *",[context.row.id,upload.id])).rows[0];
      await client.query("INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'REQUIRED_OFFICE_WORKING_COPY_FIELDS_SAVED',$2,$3::jsonb)",[req.identity.userId,context.row.tender_id,JSON.stringify({...provenance,requiredDocumentId:context.row.id,sourceDocumentId:context.form.documentId,sourceSha256:context.form.sha256,previousWorkingCopyId:current.id,workingCopyId:item.id,currentVersion:version,changedFieldCount:changedFields.length,companyId:context.row.company_id,lotKey:context.row.lot_key,originalUnchanged:true,externalWrite:false,transmitted:false})]);
      const recheck=await runRequiredDocumentRecheck(client,requirement,upload,req.identity.userId);await client.query("COMMIT");return reply.code(201).send({item,materiallyEdited:true,rereadVerified:true,visualReviewRequired:true,status:requirement.satisfaction_status,statusLabel:requirementLabel(requirement.satisfaction_status),recheck,originalUnchanged:true,externalWrite:false,transmitted:false});
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
  });
  app.get("/api/tenders/:id/required-documents/:requiredDocumentId/working-copy/office",{preHandler:read},async(req,reply)=>{
    const context=await requiredOfficeSourceContext(req,reply);if(!context)return;const requestedVersion=req.query?.version==null?null:Number(req.query.version);if(requestedVersion!=null&&(!Number.isInteger(requestedVersion)||requestedVersion<1))return reply.code(400).send({error:"working_copy_version_invalid"});
    const row=(await pool.query(`SELECT content,media_type,filename FROM tender.required_document_working_copies WHERE required_document_id=$1 AND tender_id=$2 AND company_id=$3 AND lot_key=$4 AND (($5::integer IS NULL AND is_current) OR version=$5) AND media_type=ANY($6::text[]) ORDER BY version DESC LIMIT 1`,[context.row.id,context.row.tender_id,context.companyId,context.lotKey,requestedVersion,[DOCX_MIME,XLSX_MIME]])).rows[0];if(!row)return reply.code(404).send({error:"working_copy_not_found"});return sendScopedFile(reply,{content:row.content,mimeType:row.media_type,filename:row.filename});
  });
  app.post("/api/tenders/:id/required-documents/:requiredDocumentId/working-copy",{bodyLimit:1_000_000,preHandler:[requirePermission("tender.document.analyze"),csrf]},async(req,reply)=>{
    const context=await requiredPdfSourceContext(req,reply);if(!context)return;
    if(!(await requireParticipationEligible(reply,req.params.id,context.lotKey)))return;
    const source=context.candidate,filename=safeOriginalFilename(`Arbeitskopie-${source.filename}`),sha256=crypto.createHash("sha256").update(source.content).digest("hex");
    const client=await pool.connect();
    try{await client.query("BEGIN");await client.query("SELECT id FROM tender.required_documents WHERE id=$1 AND tender_id=$2 AND company_id=$3 AND lot_key=$4 FOR UPDATE",[context.row.id,context.row.tender_id,context.companyId,context.lotKey]);const existing=(await client.query("SELECT id,version,filename,media_type,sha256 FROM tender.required_document_working_copies WHERE required_document_id=$1 AND tender_id=$2 AND company_id=$3 AND lot_key=$4 AND source_sha256=$5 AND is_current FOR UPDATE",[context.row.id,context.row.tender_id,context.companyId,context.lotKey,source.payload_sha256])).rows[0];
      if(existing){await client.query("COMMIT");return {item:existing,idempotent:true,transmitted:false}}
      await client.query("UPDATE tender.required_document_working_copies SET is_current=false WHERE required_document_id=$1 AND is_current",[context.row.id]);
      const version=Number((await client.query("SELECT coalesce(max(version),0)+1 version FROM tender.required_document_working_copies WHERE required_document_id=$1",[context.row.id])).rows[0].version),provenance={kind:"REQUIRED_SOURCE_PDF",requiredDocumentId:context.row.id,sourceDocumentId:source.id,sourceSha256:source.payload_sha256,sourceDocumentVersion:source.document_version||null,pageCount:context.pdf.pageCount},item=(await client.query(`INSERT INTO tender.required_document_working_copies(required_document_id,tender_id,lot_key,company_id,source_document_id,source_sha256,version,filename,media_type,content,sha256,overlay_data,editor_provenance,prepared_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'[]'::jsonb,$12::jsonb,$13) RETURNING id,version,filename,media_type,sha256`,[context.row.id,context.row.tender_id,context.row.lot_key,context.row.company_id,source.id,source.payload_sha256,version,filename,source.mime_type,source.content,sha256,JSON.stringify(provenance),req.identity.userId])).rows[0];
      await client.query("INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'REQUIRED_PDF_WORKING_COPY_PREPARED',$2,$3::jsonb)",[req.identity.userId,context.row.tender_id,JSON.stringify({...provenance,workingCopyId:item.id,version,companyId:context.row.company_id,lotKey:context.row.lot_key,elementCount:0,originalUnchanged:true,legalConfirmationAdded:false,externalWrite:false,transmitted:false})]);
      await client.query("COMMIT");return reply.code(201).send({item,idempotent:false,transmitted:false});
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
  });
  app.get("/api/tenders/:id/required-documents/:requiredDocumentId/working-copy/fields",{preHandler:read},async(req,reply)=>{
    const context=await requiredPdfSourceContext(req,reply);if(!context)return;
    const row=(await pool.query("SELECT id,version,content,media_type,filename,sha256,source_sha256,overlay_data FROM tender.required_document_working_copies WHERE required_document_id=$1 AND tender_id=$2 AND company_id=$3 AND lot_key=$4 AND is_current",[context.row.id,context.row.tender_id,context.companyId,context.lotKey])).rows[0];
    if(!row)return reply.code(404).send({error:"working_copy_not_found"});
    if(row.media_type!=="application/pdf")return reply.code(409).send({error:"working_copy_not_pdf",message:"Die universelle Overlay-Bearbeitung benötigt eine PDF-Arbeitskopie."});
    let inspection;try{inspection=await inspectPdfAcroForm(row.content)}catch{return reply.code(409).send({error:"working_copy_pdf_invalid"})}
    return {item:{id:row.id,version:row.version,filename:row.filename,sha256:row.sha256,sourceSha256:row.source_sha256,fields:inspection.fields,signatureFieldCount:inspection.signatureFieldCount,overlays:row.overlay_data||[],pageCount:context.pdf.pageCount,pages:context.pdf.pages,suggestedPage:context.page||1},scope:{tenderId:context.row.tender_id,companyId:context.companyId,lotKey:context.lotKey,requiredDocumentId:context.row.id},overlayEditable:true,acroFormEditable:inspection.editable,originalUnchanged:true,externalWrite:false,transmitted:false};
  });
  app.post("/api/tenders/:id/required-documents/:requiredDocumentId/working-copy/fields",{preHandler:[requirePermission("tender.document.analyze"),csrf]},async(req,reply)=>{
    const context=await requiredPdfSourceContext(req,reply);if(!context)return;
    if(!(await requireParticipationEligible(reply,req.params.id,context.lotKey)))return;
    const baseVersion=Number(req.body?.baseVersion),values=req.body?.fields;
    if(!Number.isInteger(baseVersion)||baseVersion<1)return reply.code(400).send({error:"working_copy_version_invalid"});
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      const current=(await client.query("SELECT * FROM tender.required_document_working_copies WHERE required_document_id=$1 AND tender_id=$2 AND company_id=$3 AND lot_key=$4 AND is_current FOR UPDATE",[context.row.id,context.row.tender_id,context.companyId,context.lotKey])).rows[0];
      if(!current){await client.query("ROLLBACK");return reply.code(404).send({error:"working_copy_not_found"})}
      if(Number(current.version)!==baseVersion){await client.query("ROLLBACK");return reply.code(409).send({error:"working_copy_version_conflict",currentVersion:current.version,message:"Die Arbeitskopie wurde zwischenzeitlich geändert. Bitte neu laden."})}
      if(current.media_type!=="application/pdf"){await client.query("ROLLBACK");return reply.code(409).send({error:"working_copy_not_pdf"})}
      let filled,rendered,sourceInspection;try{sourceInspection=await inspectPdfAcroForm(context.candidate.content);filled=await fillPdfAcroForm(context.candidate.content,values);rendered=await renderPdfOverlays(filled.content,current.overlay_data||[])}catch(error){await client.query("ROLLBACK");return reply.code(400).send({error:error.message,message:"Die Feldwerte oder PDF-Overlays sind ungültig."})}
      const sourceHash=crypto.createHash("sha256").update(context.candidate.content).digest("hex");
      if(sourceHash!==context.sha256||current.source_sha256!==context.sha256){await client.query("ROLLBACK");return reply.code(409).send({error:"required_source_integrity_mismatch"})}
      const materiallyEdited=materiallyEditedPdfWorkingCopy({elements:rendered.elements,sourceFields:sourceInspection.fields,fields:values}),nextStatus=materiallyEdited?"MANUAL_REVIEW_REQUIRED":"MISSING",
        version=Number((await client.query("SELECT coalesce(max(version),0)+1 version FROM tender.required_document_working_copies WHERE required_document_id=$1",[context.row.id])).rows[0].version),sha256=crypto.createHash("sha256").update(rendered.content).digest("hex"),provenance={...(current.editor_provenance||{}),materiallyEdited};
      const scan=materiallyEdited?await scanBuffer(rendered.content):null;
      if(scan&&scan.status!=="CLEAN"){await client.query("ROLLBACK");return reply.code(scan.status==="INFECTED"?422:503).send({error:scan.status==="INFECTED"?"document_rejected_malware":"malware_scanner_temporarily_unavailable",retryable:scan.status==="SCAN_ERROR"})}
      await client.query("UPDATE tender.required_document_working_copies SET is_current=false WHERE id=$1",[current.id]);
      const item=(await client.query(`INSERT INTO tender.required_document_working_copies(required_document_id,tender_id,lot_key,company_id,source_document_id,source_sha256,version,filename,media_type,content,sha256,overlay_data,editor_provenance,prepared_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14) RETURNING id,version,filename,media_type,sha256`,[context.row.id,context.row.tender_id,context.row.lot_key,context.row.company_id,context.candidate.id,context.sha256,version,current.filename,current.media_type,rendered.content,sha256,JSON.stringify(current.overlay_data||[]),JSON.stringify(provenance),req.identity.userId])).rows[0];
      let upload=null;
      if(materiallyEdited){
        await client.query("UPDATE tender.required_document_uploads SET is_current=false WHERE required_document_id=$1 AND is_current",[context.row.id]);
        const uploadVersion=Number((await client.query("SELECT coalesce(max(version),0)+1 version FROM tender.required_document_uploads WHERE required_document_id=$1",[context.row.id])).rows[0].version);
        upload=(await client.query(`INSERT INTO tender.required_document_uploads(required_document_id,tender_id,lot_key,company_id,version,filename,media_type,size_bytes,sha256,content,source_type,source_working_copy_id,validation_status,validation_summary,validation_details,malware_scan_status,uploaded_by)
          VALUES($1,$2,$3,$4,$5,$6,'application/pdf',$7,$8,$9,'REQUIRED_PDF_WORKING_COPY',$10,'MANUAL_REVIEW_REQUIRED',$11,$12::jsonb,'CLEAN',$13) RETURNING *`,[context.row.id,context.row.tender_id,context.row.lot_key,context.row.company_id,uploadVersion,current.filename,rendered.content.length,sha256,rendered.content,item.id,"Ausgefüllte PDF-Arbeitskopie gespeichert – fachliche Prüfung erforderlich.",JSON.stringify({origin:"VERSIONED_REQUIRED_PDF_WORKING_COPY",workingCopyId:item.id,workingCopyVersion:version,sourceSha256:context.sha256,automaticCompletenessProven:false}),req.identity.userId])).rows[0];
      }else await client.query("UPDATE tender.required_document_uploads SET is_current=false WHERE required_document_id=$1 AND source_type='REQUIRED_PDF_WORKING_COPY' AND is_current",[context.row.id]);
      const requirement=(await client.query(`UPDATE tender.required_documents SET current_upload_id=CASE WHEN $3::uuid IS NOT NULL THEN $3 WHEN current_upload_id IN(SELECT id FROM tender.required_document_uploads WHERE required_document_id=$1 AND source_type='REQUIRED_PDF_WORKING_COPY') THEN NULL ELSE current_upload_id END,satisfaction_status=CASE WHEN satisfaction_status='NOT_REQUIRED' THEN satisfaction_status ELSE $2 END,updated_at=now() WHERE id=$1 RETURNING *`,[context.row.id,nextStatus,upload?.id||null])).rows[0];
      await client.query("INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'REQUIRED_PDF_WORKING_COPY_FIELDS_SAVED',$2,$3::jsonb)",[req.identity.userId,context.row.tender_id,JSON.stringify({requiredDocumentId:context.row.id,sourceDocumentId:context.candidate.id,sourceSha256:context.sha256,previousWorkingCopyId:current.id,workingCopyId:item.id,baseVersion,currentVersion:version,changedFieldNames:filled.changedFields,changedFieldCount:filled.changedFields.length,companyId:context.row.company_id,lotKey:context.row.lot_key,originalUnchanged:true,signatureAdded:false,legalConfirmationAdded:false,externalWrite:false,transmitted:false})]);
      const recheck=await runRequiredDocumentRecheck(client,requirement,upload,req.identity.userId);
      await client.query("COMMIT");return reply.code(201).send({item,materiallyEdited,status:requirement.satisfaction_status,statusLabel:requirementLabel(requirement.satisfaction_status),recheck,originalUnchanged:true,signatureAdded:false,externalWrite:false,transmitted:false});
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
  });
  app.post("/api/tenders/:id/required-documents/:requiredDocumentId/working-copy/overlays",{bodyLimit:1_000_000,preHandler:[requirePermission("tender.document.analyze"),csrf]},async(req,reply)=>{
    const context=await requiredPdfSourceContext(req,reply);if(!context)return;
    if(!(await requireParticipationEligible(reply,req.params.id,context.lotKey)))return;
    const baseVersion=Number(req.body?.baseVersion),elements=req.body?.elements,requestedFields=req.body?.fields;
    if(!Number.isInteger(baseVersion)||baseVersion<1)return reply.code(400).send({error:"working_copy_version_invalid"});
    if(requestedFields!=null&&(!requestedFields||typeof requestedFields!=="object"||Array.isArray(requestedFields)))return reply.code(400).send({error:"pdf_form_values_invalid"});
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      const current=(await client.query("SELECT * FROM tender.required_document_working_copies WHERE required_document_id=$1 AND tender_id=$2 AND company_id=$3 AND lot_key=$4 AND is_current FOR UPDATE",[context.row.id,context.row.tender_id,context.companyId,context.lotKey])).rows[0];
      if(!current){await client.query("ROLLBACK");return reply.code(404).send({error:"working_copy_not_found"})}
      if(Number(current.version)!==baseVersion){await client.query("ROLLBACK");return reply.code(409).send({error:"working_copy_version_conflict",currentVersion:current.version,message:"Die Arbeitskopie wurde zwischenzeitlich geändert. Bitte neu laden."})}
      if(current.media_type!=="application/pdf"||current.source_document_id!==context.candidate.id||current.source_sha256!==context.sha256){await client.query("ROLLBACK");return reply.code(409).send({error:"required_source_binding_mismatch"})}
      const sourceInspection=await inspectPdfAcroForm(context.candidate.content);
      let fields=requestedFields;
      if(fields==null){const inspection=await inspectPdfAcroForm(current.content);fields=Object.fromEntries(inspection.editableFields.map(field=>[field.name,field.value]))}
      let renderBase=context.candidate.content,changedFieldNames=[];
      try{if(Object.keys(fields).length){const filled=await fillPdfAcroForm(renderBase,fields);renderBase=filled.content;changedFieldNames=filled.changedFields}}
      catch(error){await client.query("ROLLBACK");return reply.code(400).send({error:error.message,message:"AcroForm-Werte passen nicht exakt zur Source-PDF."})}
      let rendered;try{rendered=await renderPdfOverlays(renderBase,elements)}catch(error){await client.query("ROLLBACK");return reply.code(400).send({error:error.message,message:"Overlay-Daten sind ungültig."})}
      const sourceHash=crypto.createHash("sha256").update(context.candidate.content).digest("hex");
      if(sourceHash!==context.sha256){await client.query("ROLLBACK");return reply.code(409).send({error:"required_source_integrity_mismatch"})}
      const materiallyEdited=materiallyEditedPdfWorkingCopy({elements:rendered.elements,sourceFields:sourceInspection.fields,fields}),nextStatus=materiallyEdited?"MANUAL_REVIEW_REQUIRED":"MISSING",
        version=Number((await client.query("SELECT coalesce(max(version),0)+1 version FROM tender.required_document_working_copies WHERE required_document_id=$1",[context.row.id])).rows[0].version),sha256=crypto.createHash("sha256").update(rendered.content).digest("hex"),summary=summarizePdfOverlays(rendered.elements),provenance={kind:"REQUIRED_SOURCE_PDF_OVERLAY",requiredDocumentId:context.row.id,sourceDocumentId:context.candidate.id,sourceSha256:context.sha256,pageCount:rendered.pageCount,baseVersion,materiallyEdited};
      const scan=materiallyEdited?await scanBuffer(rendered.content):null;
      if(scan&&scan.status!=="CLEAN"){await client.query("ROLLBACK");return reply.code(scan.status==="INFECTED"?422:503).send({error:scan.status==="INFECTED"?"document_rejected_malware":"malware_scanner_temporarily_unavailable",retryable:scan.status==="SCAN_ERROR"})}
      await client.query("UPDATE tender.required_document_working_copies SET is_current=false WHERE id=$1",[current.id]);
      const item=(await client.query(`INSERT INTO tender.required_document_working_copies(required_document_id,tender_id,lot_key,company_id,source_document_id,source_sha256,version,filename,media_type,content,sha256,overlay_data,editor_provenance,prepared_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'application/pdf',$9,$10,$11::jsonb,$12::jsonb,$13) RETURNING id,version,filename,media_type,sha256`,[context.row.id,context.row.tender_id,context.row.lot_key,context.row.company_id,context.candidate.id,context.sha256,version,current.filename,rendered.content,sha256,JSON.stringify(rendered.elements),JSON.stringify(provenance),req.identity.userId])).rows[0];
      let upload=null;
      if(materiallyEdited){
        await client.query("UPDATE tender.required_document_uploads SET is_current=false WHERE required_document_id=$1 AND is_current",[context.row.id]);
        const uploadVersion=Number((await client.query("SELECT coalesce(max(version),0)+1 version FROM tender.required_document_uploads WHERE required_document_id=$1",[context.row.id])).rows[0].version);
        upload=(await client.query(`INSERT INTO tender.required_document_uploads(required_document_id,tender_id,lot_key,company_id,version,filename,media_type,size_bytes,sha256,content,source_type,source_working_copy_id,validation_status,validation_summary,validation_details,malware_scan_status,uploaded_by)
          VALUES($1,$2,$3,$4,$5,$6,'application/pdf',$7,$8,$9,'REQUIRED_PDF_WORKING_COPY',$10,'MANUAL_REVIEW_REQUIRED',$11,$12::jsonb,'CLEAN',$13) RETURNING *`,[context.row.id,context.row.tender_id,context.row.lot_key,context.row.company_id,uploadVersion,current.filename,rendered.content.length,sha256,rendered.content,item.id,"Ausgefüllte PDF-Arbeitskopie gespeichert – fachliche Prüfung erforderlich.",JSON.stringify({origin:"VERSIONED_REQUIRED_PDF_WORKING_COPY",workingCopyId:item.id,workingCopyVersion:version,sourceSha256:context.sha256,automaticCompletenessProven:false}),req.identity.userId])).rows[0];
      }else{
        await client.query("UPDATE tender.required_document_uploads SET is_current=false WHERE required_document_id=$1 AND source_type='REQUIRED_PDF_WORKING_COPY' AND is_current",[context.row.id]);
      }
      const requirement=(await client.query(`UPDATE tender.required_documents SET current_upload_id=CASE WHEN $3::uuid IS NOT NULL THEN $3 WHEN current_upload_id IN(SELECT id FROM tender.required_document_uploads WHERE required_document_id=$1 AND source_type='REQUIRED_PDF_WORKING_COPY') THEN NULL ELSE current_upload_id END,satisfaction_status=CASE WHEN satisfaction_status='NOT_REQUIRED' THEN satisfaction_status ELSE $2 END,updated_at=now() WHERE id=$1 RETURNING *`,[context.row.id,nextStatus,upload?.id||null])).rows[0];
      await client.query("INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'REQUIRED_PDF_WORKING_COPY_OVERLAYS_SAVED',$2,$3::jsonb)",[req.identity.userId,context.row.tender_id,JSON.stringify({...provenance,...summary,previousWorkingCopyId:current.id,workingCopyId:item.id,currentVersion:version,changedFieldNames,changedFieldCount:changedFieldNames.length,companyId:context.row.company_id,lotKey:context.row.lot_key,originalUnchanged:true,signatureAdded:false,legalConfirmationAdded:false,externalWrite:false,transmitted:false})]);
      const recheck=await runRequiredDocumentRecheck(client,requirement,upload,req.identity.userId);
      await client.query("COMMIT");return reply.code(201).send({item,elementCount:summary.elementCount,materiallyEdited,status:requirement.satisfaction_status,statusLabel:requirementLabel(requirement.satisfaction_status),recheck,originalUnchanged:true,signatureAdded:false,externalWrite:false,transmitted:false});
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
  });
  app.get("/api/tenders/:id/required-documents/:requiredDocumentId/working-copy",{preHandler:read},async(req,reply)=>{
    const context=await requiredPdfSourceContext(req,reply);if(!context)return;
    const requestedVersion=req.query?.version==null?null:Number(req.query.version);if(requestedVersion!=null&&(!Number.isInteger(requestedVersion)||requestedVersion<1))return reply.code(400).send({error:"working_copy_version_invalid"});
    const row=(await pool.query(`SELECT content,media_type,filename FROM tender.required_document_working_copies WHERE required_document_id=$1 AND tender_id=$2 AND company_id=$3 AND lot_key=$4 AND (($5::integer IS NULL AND is_current) OR version=$5) ORDER BY version DESC LIMIT 1`,[context.row.id,context.row.tender_id,context.companyId,context.lotKey,requestedVersion])).rows[0];
    if(!row)return reply.code(404).send({error:"working_copy_not_found"});return sendScopedFile(reply,{content:row.content,mimeType:row.media_type,filename:row.filename,inline:row.media_type==="application/pdf"});
  });
  app.get("/api/management/required-documents-inbox",{preHandler:read},async(req)=>{
    const companyIds=req.identity.permissions.includes("tender.admin")?null:req.identity.companyIds;
    const rows=(await pool.query(`SELECT r.id,r.tender_id,r.requirement_title,r.requirement_description,r.source_reference,r.source_page,r.category,r.document_type,r.mandatory,r.submission_relevant,r.satisfaction_status,r.lot_key,r.company_id,t.title,t.offer_deadline,c.legal_name company_name,fp.service_line,coalesce(p.display_name,'Kein Submission-Portal gebunden') portal_name,
      CASE WHEN t.offer_deadline<now()+interval '2 days' THEN 'CRITICAL' ELSE 'NORMAL' END priority
      FROM tender.required_documents r JOIN tender.current_registered_tender_company_portals registered ON registered.tender_id=r.tender_id AND registered.company_id=r.company_id JOIN tender.tenders t ON t.id=r.tender_id JOIN tender.enterprise_company_links c ON c.company_id=r.company_id
      LEFT JOIN tender.final_preflight_contexts fp ON fp.tender_id=r.tender_id AND fp.company_id=r.company_id AND fp.lot_key=r.lot_key AND fp.is_current
      LEFT JOIN tender.submission_contexts sc ON sc.id=fp.submission_context_id LEFT JOIN tender.portal_registry p ON p.id=sc.portal_id
      WHERE r.mandatory AND r.submission_relevant AND r.manual_submission_relevance_override IS DISTINCT FROM false AND r.satisfaction_status IN('MISSING','REJECTED','MANUAL_REVIEW_REQUIRED','UPLOADED_PENDING_VALIDATION')
      AND ($1::uuid[] IS NULL OR r.company_id=ANY($1)) AND ($2='' OR r.company_id::text=$2) AND ($3='' OR fp.service_line=$3) AND ($4='' OR r.tender_id::text=$4) AND ($5='' OR r.lot_key=$5) AND ($6='' OR (CASE WHEN t.offer_deadline<now()+interval '2 days' THEN 'CRITICAL' ELSE 'NORMAL' END)=$6)
      ORDER BY t.offer_deadline NULLS LAST,r.requirement_title`,[companyIds,String(req.query?.company||''),String(req.query?.serviceLine||''),String(req.query?.tender||''),String(req.query?.lot||''),String(req.query?.priority||'')])).rows;
    return {items:rows.map(x=>({...x,status_label:requirementLabel(x.satisfaction_status)})),filterLabel:"Fehlende, abgelehnte oder zu prüfende Unterlagen"};
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
    const row=(await pool.query(`SELECT fr.*,fp.tender_id,fp.lot_key,fp.company_id,ed.content,ed.filename,ed.payload_sha256,scan.status malware_scan_status FROM tender.final_preflight_requirements fr JOIN tender.final_preflight_contexts fp ON fp.id=fr.context_id JOIN tender.enrichment_documents ed ON ed.id=fr.source_document_id LEFT JOIN tender.document_malware_scans scan ON scan.document_id=ed.id AND scan.payload_sha256=ed.payload_sha256 WHERE fr.id=$1 AND fr.action_group='SIGNATURE'`,[requirementId])).rows[0];
    if(!row)return reply.code(404).send({error:"signature_requirement_not_found"});
    if(row.malware_scan_status!=="CLEAN")return reply.code(423).send({error:"source_document_quarantined",scanStatus:row.malware_scan_status||"PENDING"});
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
    if(!(await requireParticipationEligible(reply,req.params.id,req.body?.lot)))return;
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
    if(!(await visibleTender(req,reply,req.params.id)))return;
    if(!(await requireParticipationEligible(reply,req.params.id,req.body?.lot)))return;
    const decision=String(req.body?.decision||""),reason=String(req.body?.reason||"").trim(),companyId=String(req.body?.company||""),lotKey=String(req.body?.lot??""),target=req.body?.target,
      validHash=value=>/^[0-9a-f]{64}$/.test(String(value||""));
    if(!validUuid(req.params.requiredDocumentId)||!validUuid(companyId)||!["VALIDATED","REJECTED"].includes(decision)||!reason||reason.length>4000||!target||!["UPLOAD","WORKING_COPY"].includes(target.type)||!validUuid(target.id)||!Number.isInteger(target.version)||target.version<1||!validHash(target.sha256))return reply.code(400).send({error:"required_document_review_contract_invalid"});
    if(target.type==="WORKING_COPY"&&(!validUuid(target.sourceDocumentId)||!validHash(target.sourceSha256)))return reply.code(400).send({error:"required_document_review_contract_invalid"});
    if(!req.identity.permissions.includes("tender.admin")&&!req.identity.companyIds.includes(companyId))return reply.code(403).send({error:"company_scope_forbidden"});
    const client=await pool.connect();try{await client.query("BEGIN");const requirement=(await client.query("SELECT * FROM tender.required_documents WHERE id=$1 AND tender_id=$2 AND company_id=$3 AND lot_key=$4 AND satisfaction_status<>'SUPERSEDED' FOR UPDATE",[req.params.requiredDocumentId,req.params.id,companyId,lotKey])).rows[0];
      if(!requirement){await client.query("ROLLBACK");return reply.code(404).send({error:"required_document_not_found"})}
      if(!(await requireRegisteredScope(reply,requirement.tender_id,requirement.company_id))){await client.query("ROLLBACK");return}
      const currentUpload=(await client.query("SELECT * FROM tender.required_document_uploads WHERE required_document_id=$1 AND is_current FOR UPDATE",[requirement.id])).rows[0];
      if(String(requirement.current_upload_id||"")!==String(currentUpload?.id||"")){await client.query("ROLLBACK");return reply.code(409).send({error:"required_document_upload_linkage_changed"})}
      let upload=currentUpload,workingCopy=null,reviewTarget;
      if(target.type==="UPLOAD"){
        if(!upload||upload.id!==target.id||Number(upload.version)!==target.version||upload.sha256!==target.sha256||upload.source_working_copy_id){await client.query("ROLLBACK");return reply.code(409).send({error:"required_document_review_target_changed"})}
        if(requirement.satisfaction_status!=="MANUAL_REVIEW_REQUIRED"||!["MANUAL_REVIEW_REQUIRED","UPLOADED_PENDING_VALIDATION"].includes(upload.validation_status)){await client.query("ROLLBACK");return reply.code(409).send({error:"required_document_not_review_ready"})}
        upload=(await client.query("UPDATE tender.required_document_uploads SET validation_status=$2,validation_summary=$3,reviewed_by=$4,reviewed_at=now() WHERE id=$1 AND is_current RETURNING *",[upload.id,decision,reason,req.identity.userId])).rows[0];
        reviewTarget={type:"UPLOAD",uploadId:upload.id,uploadVersion:upload.version,uploadSha256:upload.sha256};
      }else{
        workingCopy=(await client.query("SELECT * FROM tender.required_document_working_copies WHERE id=$1 AND required_document_id=$2 AND tender_id=$3 AND company_id=$4 AND lot_key=$5 AND is_current FOR UPDATE",[target.id,requirement.id,requirement.tender_id,companyId,lotKey])).rows[0];
        if(!workingCopy||Number(workingCopy.version)!==target.version||workingCopy.sha256!==target.sha256||workingCopy.source_document_id!==target.sourceDocumentId||workingCopy.source_sha256!==target.sourceSha256||requirement.source_document_id!==workingCopy.source_document_id){await client.query("ROLLBACK");return reply.code(409).send({error:"required_document_review_target_changed"})}
        const source=(await client.query("SELECT id,payload_sha256 FROM tender.enrichment_documents WHERE id=$1",[workingCopy.source_document_id])).rows[0],material=workingCopy.editor_provenance?.materiallyEdited===true||materiallyEditedPdfWorkingCopy({elements:workingCopy.overlay_data||[]});
        if(!source||source.payload_sha256!==workingCopy.source_sha256||!material){await client.query("ROLLBACK");return reply.code(409).send({error:!material?"working_copy_not_materially_edited":"required_source_binding_mismatch"})}
        if(!["MANUAL_REVIEW_REQUIRED","MISSING"].includes(requirement.satisfaction_status)||requirement.satisfaction_status==="MISSING"&&upload){await client.query("ROLLBACK");return reply.code(409).send({error:"required_document_not_review_ready"})}
        const officeWorkingCopy=[DOCX_MIME,XLSX_MIME].includes(workingCopy.media_type),workingCopySourceType=officeWorkingCopy?"REQUIRED_OFFICE_WORKING_COPY":"REQUIRED_PDF_WORKING_COPY",workingCopyOrigin=officeWorkingCopy?"HUMAN_CONFIRMED_VERSIONED_REQUIRED_OFFICE_WORKING_COPY":"HUMAN_CONFIRMED_VERSIONED_REQUIRED_PDF_WORKING_COPY";
        if(upload){
          if(upload.source_type!==workingCopySourceType||upload.source_working_copy_id!==workingCopy.id||upload.sha256!==workingCopy.sha256||!["MANUAL_REVIEW_REQUIRED","UPLOADED_PENDING_VALIDATION"].includes(upload.validation_status)){await client.query("ROLLBACK");return reply.code(409).send({error:"required_document_working_copy_linkage_changed"})}
          upload=(await client.query("UPDATE tender.required_document_uploads SET validation_status=$2,validation_summary=$3,reviewed_by=$4,reviewed_at=now() WHERE id=$1 AND is_current RETURNING *",[upload.id,decision,reason,req.identity.userId])).rows[0];
        }else{
          const scan=await scanDocument(workingCopy.content);if(scan.status!=="CLEAN"){await client.query("ROLLBACK");return reply.code(scan.status==="INFECTED"?422:503).send({error:scan.status==="INFECTED"?"document_rejected_malware":"malware_scanner_temporarily_unavailable",retryable:scan.status==="SCAN_ERROR"})}
          const version=Number((await client.query("SELECT coalesce(max(version),0)+1 version FROM tender.required_document_uploads WHERE required_document_id=$1",[requirement.id])).rows[0].version);
          upload=(await client.query(`INSERT INTO tender.required_document_uploads(required_document_id,tender_id,lot_key,company_id,version,filename,media_type,size_bytes,sha256,content,source_type,source_working_copy_id,validation_status,validation_summary,validation_details,malware_scan_status,uploaded_by,reviewed_by,reviewed_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,'CLEAN',$16,$17,now()) RETURNING *`,[requirement.id,requirement.tender_id,requirement.lot_key,requirement.company_id,version,workingCopy.filename,workingCopy.media_type,workingCopy.content.length,workingCopy.sha256,workingCopy.content,workingCopySourceType,workingCopy.id,decision,reason,JSON.stringify({origin:workingCopyOrigin,workingCopyId:workingCopy.id,workingCopyVersion:workingCopy.version,workingCopySha256:workingCopy.sha256,sourceDocumentId:workingCopy.source_document_id,sourceSha256:workingCopy.source_sha256,automaticCompletenessProven:false,automaticVisualCompletenessProven:false}),workingCopy.prepared_by,req.identity.userId])).rows[0];
        }
        reviewTarget={type:"WORKING_COPY",uploadId:upload.id,uploadVersion:upload.version,uploadSha256:upload.sha256,workingCopyId:workingCopy.id,workingCopyVersion:workingCopy.version,workingCopySha256:workingCopy.sha256,sourceDocumentId:workingCopy.source_document_id,sourceSha256:workingCopy.source_sha256};
      }
      const updated=(await client.query("UPDATE tender.required_documents SET current_upload_id=$2,satisfaction_status=$3,updated_at=now() WHERE id=$1 RETURNING *",[requirement.id,upload.id,decision])).rows[0];
      await client.query("INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,$2,$3,$4::jsonb)",[req.identity.userId,decision==="VALIDATED"?"REQUIRED_DOCUMENT_CONFIRMED":"REQUIRED_DOCUMENT_REJECTED",requirement.tender_id,JSON.stringify({requiredDocumentId:requirement.id,companyId:requirement.company_id,lotKey:requirement.lot_key,decision,reason,...reviewTarget,explicitHumanConfirmation:true,externalWrite:false,transmitted:false})]);
      const recheck=await runRequiredDocumentRecheck(client,updated,upload,req.identity.userId);await client.query("COMMIT");return {status:decision,statusLabel:requirementLabel(decision),reviewTarget,recheck,transmitted:false};
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
  });
  app.get("/api/tenders/:id/required-documents/:requiredDocumentId/download",{preHandler:read},async(req,reply)=>{
    if(!(await visibleTender(req,reply,req.params.id)))return;const row=(await pool.query(`SELECT u.content,u.media_type,u.filename,r.company_id,r.tender_id FROM tender.required_documents r JOIN tender.required_document_uploads u ON u.id=r.current_upload_id WHERE r.id=$1 AND r.tender_id=$2 AND u.malware_scan_status='CLEAN'`,[req.params.requiredDocumentId,req.params.id])).rows[0];
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
