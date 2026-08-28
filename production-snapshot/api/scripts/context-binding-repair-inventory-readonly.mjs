import fs from "node:fs";
import pg from "pg";
import {createFixedScopedPool,loadBackgroundScope} from "../platform/scoped-pg-pool.mjs";

const connectionString=process.env.DATABASE_URL||fs.readFileSync(
  process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8",
).trim();
const rawPool=new pg.Pool({connectionString,max:1,options:["-c default_transaction_read_only=on -c statement_timeout=120000",process.env.DATABASE_SESSION_OPTIONS].filter(Boolean).join(" ")});
const pool=createFixedScopedPool(rawPool,await loadBackgroundScope(rawPool)).pool;
const client=await pool.connect();
try{
  await client.query("BEGIN READ ONLY");
  const exactBindingCandidates=(await client.query(`WITH candidate AS(
    SELECT context.id context_id,company.legal_name,context.tender_id,context.company_id,context.lot_key,
      count(DISTINCT scope.profile_id)::int exact_profile_scopes,
      count(DISTINCT lot.id)::int exact_canonical_lots,
      count(DISTINCT enrichment.id)::int current_enrichments,
      count(DISTINCT version.id)::int latest_tender_versions,
      EXISTS(SELECT 1 FROM tender.current_service_relevance relevance
        WHERE relevance.tender_id=context.tender_id AND relevance.company_id=context.company_id
          AND relevance.lot_key=context.lot_key AND relevance.relevance_status='RELEVANT'
          AND relevance.service_scope_gate='PASSED' AND relevance.primary_company=true) exact_relevance,
      EXISTS(SELECT 1 FROM tender.tender_lot_selections selection
        WHERE selection.tender_id=context.tender_id AND selection.company_id=context.company_id
          AND selection.source_lot_id=context.lot_key
          AND EXISTS(SELECT 1 FROM tender.lots selected_lot WHERE selected_lot.id=selection.lot_id
            AND selected_lot.tender_id=context.tender_id AND selected_lot.external_id=context.lot_key)) exact_selection
    FROM tender.pipeline_contexts context
    JOIN tender.tenders tender ON tender.id=context.tender_id AND tender.source_lifecycle_status='ACTIVE'
    JOIN tender.enterprise_company_links company ON company.company_id=context.company_id AND company.active=true
    LEFT JOIN tender.configuration_scopes scope ON scope.company_id=context.company_id
      AND scope.profile_id=company.tender_profile_id
    LEFT JOIN tender.lots lot ON lot.tender_id=context.tender_id AND lot.external_id=context.lot_key
    LEFT JOIN LATERAL(SELECT candidate.id FROM tender.enrichment_versions candidate
      WHERE candidate.tender_id=context.tender_id AND candidate.historical=false
      ORDER BY candidate.version DESC,candidate.created_at DESC,candidate.id DESC LIMIT 1)enrichment ON true
    LEFT JOIN LATERAL(SELECT candidate.id FROM tender.tender_versions candidate
      WHERE candidate.tender_id=context.tender_id
      ORDER BY candidate.version DESC,candidate.created_at DESC,candidate.id DESC LIMIT 1)version ON true
    WHERE context.lot_key<>'' AND NOT EXISTS(SELECT 1 FROM tender.enrichment_context_bindings binding
      JOIN tender.enrichment_versions bound_enrichment ON bound_enrichment.id=binding.enrichment_version_id
        AND bound_enrichment.historical=false
      WHERE binding.company_id=context.company_id AND binding.tender_id=context.tender_id
        AND binding.source_lot_id=context.lot_key AND binding.lot_id=lot.id)
    GROUP BY context.id,company.legal_name,context.tender_id,context.company_id,context.lot_key
  ) SELECT legal_name,count(*)::int contexts,
      count(*) FILTER(WHERE exact_profile_scopes=1 AND exact_canonical_lots=1
        AND current_enrichments=1 AND latest_tender_versions=1
        AND (exact_relevance OR exact_selection))::int safely_repairable,
      count(*) FILTER(WHERE exact_profile_scopes<>1)::int profile_scope_ambiguous,
      count(*) FILTER(WHERE exact_canonical_lots<>1)::int canonical_lot_ambiguous,
      count(*) FILTER(WHERE current_enrichments<>1)::int current_enrichment_missing,
      count(*) FILTER(WHERE latest_tender_versions<>1)::int tender_version_missing,
      count(*) FILTER(WHERE NOT exact_relevance)::int exact_relevance_missing,
      count(*) FILTER(WHERE NOT exact_relevance AND NOT exact_selection)::int authoritative_context_evidence_missing
    FROM candidate GROUP BY legal_name ORDER BY legal_name`)).rows;
  const missingEnrichment=(await client.query(`WITH missing AS(
    SELECT context.id,company.legal_name,context.tender_id,
      (SELECT count(*) FROM tender.tender_lot_lifecycles lifecycle
        WHERE lifecycle.tender_id=context.tender_id AND lifecycle.is_current
          AND lifecycle.lifecycle_status='ACTIVE' AND lifecycle.participation_status='ELIGIBLE'
          AND lifecycle.offer_deadline>now())::int eligible_lots,
      EXISTS(SELECT 1 FROM tender.tender_lot_selections selection
        WHERE selection.tender_id=context.tender_id AND selection.company_id=context.company_id) explicit_selection,
      EXISTS(SELECT 1 FROM tender.tender_lot_selections selection
        JOIN tender.current_tender_company_portal_role_scopes portal
          ON portal.tenant_id=selection.tenant_id AND portal.company_id=selection.company_id
          AND portal.tender_id=selection.tender_id AND portal.tender_version_id=selection.tender_version_id
          AND portal.lot_id=selection.lot_id AND portal.source_lot_id=selection.source_lot_id
          AND portal.portal_role='DOCUMENT_PORTAL'
        WHERE selection.tender_id=context.tender_id AND selection.company_id=context.company_id
      ) exact_document_portal_assignment,
      EXISTS(SELECT 1 FROM tender.tender_lot_selections selection
        JOIN tender.current_tender_company_portal_role_scopes portal
          ON portal.tenant_id=selection.tenant_id AND portal.company_id=selection.company_id
          AND portal.tender_id=selection.tender_id AND portal.tender_version_id=selection.tender_version_id
          AND portal.lot_id=selection.lot_id AND portal.source_lot_id=selection.source_lot_id
          AND portal.portal_role='DOCUMENT_PORTAL' AND portal.credential_id IS NOT NULL
        WHERE selection.tender_id=context.tender_id AND selection.company_id=context.company_id
      ) exact_document_credential
    FROM tender.pipeline_contexts context
    JOIN tender.tenders tender ON tender.id=context.tender_id AND tender.source_lifecycle_status='ACTIVE'
      AND tender.data_class='PUBLIC_REAL'
    JOIN tender.enterprise_company_links company ON company.company_id=context.company_id AND company.active=true
    WHERE context.lot_key='' AND NOT EXISTS(SELECT 1 FROM tender.enrichment_versions enrichment
      WHERE enrichment.tender_id=context.tender_id AND enrichment.historical=false)
  ) SELECT legal_name,count(*)::int contexts,
      count(*) FILTER(WHERE eligible_lots=0)::int no_eligible_lot,
      count(*) FILTER(WHERE eligible_lots=1)::int one_eligible_lot,
      count(*) FILTER(WHERE eligible_lots>1)::int multiple_eligible_lots,
      count(*) FILTER(WHERE explicit_selection)::int explicit_selection_exists,
      count(*) FILTER(WHERE exact_document_portal_assignment)::int exact_document_portal_assignment,
      count(*) FILTER(WHERE exact_document_credential)::int queueable_exact_scope
    FROM missing GROUP BY legal_name ORDER BY legal_name`)).rows;
  const remainingDetails=(await client.query(`SELECT context.id context_id,context.context_integrity_status,
      context.tender_id,tender.external_id,tender.source_code,tender.source_url,tender.offer_deadline,
      context.company_id,company.legal_name,context.lot_key,context.lot_id,context.enrichment_version_id,
      context.pipeline_version,context.current_step,context.fachlich_status,context.blocking_state,
      context.source_snapshot_id,context.portal_snapshot_id,context.profile_snapshot_id,
      context.context_integrity_reason,context.created_at context_created_at,context.updated_at context_updated_at,
      EXISTS(SELECT 1 FROM tender.tender_lot_selections selection
        WHERE selection.tender_id=context.tender_id AND selection.company_id=context.company_id) explicit_selection,
      (SELECT jsonb_agg(jsonb_build_object('lotKey',relevance.lot_key,'status',relevance.relevance_status,
          'scopeGate',relevance.service_scope_gate,'primaryCompany',relevance.primary_company))
        FROM tender.current_service_relevance relevance
        WHERE relevance.tender_id=context.tender_id AND relevance.company_id=context.company_id) relevance_evidence,
      (SELECT count(*)::int FROM tender.tender_lot_lifecycles lifecycle
        WHERE lifecycle.tender_id=context.tender_id AND lifecycle.is_current
          AND lifecycle.lifecycle_status='ACTIVE' AND lifecycle.participation_status='ELIGIBLE'
          AND lifecycle.offer_deadline>now()) eligible_lots
    FROM tender.pipeline_contexts context
    JOIN tender.tenders tender ON tender.id=context.tender_id AND tender.source_lifecycle_status='ACTIVE'
    JOIN tender.enterprise_company_links company ON company.company_id=context.company_id AND company.active=true
    WHERE (context.enrichment_version_id IS NULL OR (context.lot_key<>'' AND NOT EXISTS(
      SELECT 1 FROM tender.enrichment_context_bindings binding
      WHERE binding.company_id=context.company_id AND binding.tender_id=context.tender_id
        AND binding.source_lot_id=context.lot_key AND binding.lot_id=context.lot_id
        AND binding.enrichment_version_id=context.enrichment_version_id)))
    ORDER BY tender.offer_deadline,company.legal_name,context.id`)).rows;
  const repairStatusInventory=(await client.query(`SELECT context.context_integrity_reason,
      tender.source_lifecycle_status,count(*)::int contexts,
      count(*) FILTER(WHERE tender.offer_deadline IS NOT NULL AND tender.offer_deadline<=now())::int deadline_closed,
      count(*) FILTER(WHERE tender.offer_deadline>now())::int deadline_open,
      count(*) FILTER(WHERE tender.offer_deadline IS NULL)::int deadline_unknown
    FROM tender.pipeline_contexts context JOIN tender.tenders tender ON tender.id=context.tender_id
    WHERE context.context_integrity_status='REPAIR_REQUIRED'
    GROUP BY context.context_integrity_reason,tender.source_lifecycle_status
    ORDER BY context.context_integrity_reason,tender.source_lifecycle_status`)).rows;
  const totals={
    exactBindingContexts:exactBindingCandidates.reduce((sum,row)=>sum+row.contexts,0),
    safelyRepairableBindings:exactBindingCandidates.reduce((sum,row)=>sum+row.safely_repairable,0),
    activePublicMissingEnrichment:missingEnrichment.reduce((sum,row)=>sum+row.contexts,0),
    missingEnrichmentWithExplicitSelection:missingEnrichment.reduce((sum,row)=>sum+row.explicit_selection_exists,0),
    missingEnrichmentWithDocumentPortalAssignment:missingEnrichment.reduce((sum,row)=>sum+row.exact_document_portal_assignment,0),
    safelyQueueableMissingEnrichment:missingEnrichment.reduce((sum,row)=>sum+row.queueable_exact_scope,0),
  };
  await client.query("ROLLBACK");
  console.log(JSON.stringify({capturedAt:new Date().toISOString(),transaction:"READ_ONLY_ROLLED_BACK",
    totals,repairStatusInventory,exactBindingCandidates,missingEnrichment,remainingDetails},null,2));
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{await client.release();await rawPool.end()}
