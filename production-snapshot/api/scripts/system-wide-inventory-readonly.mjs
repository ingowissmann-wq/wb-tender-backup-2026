import fs from "node:fs";
import pg from "pg";
import {createFixedScopedPool,loadBackgroundScope} from "../platform/scoped-pg-pool.mjs";

const connectionString = process.env.DATABASE_URL || fs.readFileSync(
  process.env.DATABASE_URL_FILE || "/run/secrets/database_url",
  "utf8",
).trim();
const rawPool = new pg.Pool({
  connectionString,
  max: 1,
  options: [
    "-c default_transaction_read_only=on -c statement_timeout=120000 -c lock_timeout=5000",
    process.env.DATABASE_SESSION_OPTIONS,
  ].filter(Boolean).join(" "),
});
const pool=createFixedScopedPool(rawPool,await loadBackgroundScope(rawPool)).pool;

const client = await pool.connect();
const rows = async (sql, params = []) => (await client.query(sql, params)).rows;
const scalar = async (sql, params = []) => Number((await rows(sql, params))[0]?.count || 0);
const tableExists = async (name) => Boolean((await rows("SELECT to_regclass($1) name", [name]))[0]?.name);

try {
  await client.query("BEGIN READ ONLY");

  const tables = await rows(`SELECT table_name
    FROM information_schema.tables
    WHERE table_schema='tender'
    ORDER BY table_name`);
  const tableSet = new Set(tables.map(({ table_name }) => table_name));
  const selectedColumns = await rows(`SELECT table_name,column_name,data_type,is_nullable
    FROM information_schema.columns
    WHERE table_schema='tender'
      AND table_name = ANY($1::text[])
    ORDER BY table_name,ordinal_position`, [[
      "enterprise_company_links", "company_profiles", "configuration_scopes",
      "portal_registry", "portal_adapters", "portal_capability_profiles", "portal_capability_features",
      "portal_credential_secrets", "portal_credential_companies", "portal_read_sessions",
      "tenders", "tender_versions", "lots", "tender_lot_lifecycles",
      "source_references", "tender_external_links", "tender_portal_resolutions", "tender_portal_assignments",
      "enrichment_versions", "enrichment_lots", "enrichment_context_bindings", "pipeline_contexts",
      "enrichment_documents", "calculations", "required_documents", "bid_packages",
      "approval_requests", "submission_contexts", "submission_jobs", "submission_receipts",
    ]]);
  const columnSet = new Set(selectedColumns.map(({ table_name, column_name }) => `${table_name}.${column_name}`));
  const hasColumn = (table, column) => columnSet.has(`${table}.${column}`);

  const companies = await rows(`SELECT company.company_id,company.legal_name,company.sector_slug,
      company.active,company.tender_profile_id,company.sector_status,company.discovery_status,
      company.matching_status,company.calculation_status,company.configuration_version,
      array_agg(DISTINCT scope.tenant_id) FILTER(WHERE scope.tenant_id IS NOT NULL) tenant_ids,
      array_agg(DISTINCT scope.canonical_service) FILTER(WHERE scope.canonical_service IS NOT NULL) service_scopes,
      count(DISTINCT scope.profile_id)::int configuration_scopes,
      count(DISTINCT credential_scope.credential_id) FILTER(WHERE credential_scope.active AND credential.status='ACTIVE')::int active_credentials,
      count(DISTINCT credential.portal_id) FILTER(WHERE credential_scope.active AND credential.status='ACTIVE')::int credential_portals,
      count(DISTINCT session.id) FILTER(WHERE tender.portal_session_effective_status(session.status,session.expires_at,session.revoked_at,session.verification_status)='ACTIVE')::int effective_sessions
    FROM tender.enterprise_company_links company
    LEFT JOIN tender.configuration_scopes scope ON scope.company_id=company.company_id
    LEFT JOIN tender.portal_credential_companies credential_scope ON credential_scope.company_id=company.company_id
    LEFT JOIN tender.portal_credential_secrets credential ON credential.id=credential_scope.credential_id
    LEFT JOIN tender.portal_read_sessions session ON session.credential_id=credential.id AND session.company_id=company.company_id
    GROUP BY company.company_id,company.legal_name,company.sector_slug,company.active,company.tender_profile_id,
      company.sector_status,company.discovery_status,company.matching_status,company.calculation_status,company.configuration_version
    ORDER BY company.active DESC,company.legal_name`);

  const companyProfiles = await rows(`SELECT company.company_id,company.legal_name,profile.id profile_id,
      profile.version,profile.status,profile.lifecycle_status,profile.profile_sha256,
      jsonb_array_length(CASE WHEN jsonb_typeof(profile.certifications)='array' THEN profile.certifications ELSE '[]'::jsonb END)::int certifications,
      jsonb_array_length(CASE WHEN jsonb_typeof(profile.reference_profile)='array' THEN profile.reference_profile ELSE '[]'::jsonb END)::int references,
      profile.capabilities IS NOT NULL capabilities_present,
      profile.commercial_profile IS NOT NULL commercial_profile_present
    FROM tender.enterprise_company_links company
    LEFT JOIN tender.company_profiles profile ON profile.id=company.tender_profile_id
    ORDER BY company.legal_name`);

  const portalRegistry = await rows(`SELECT id,display_name,canonical_domain,allowed_subdomains,
      portal_family_key,adapter_id,adapter_enabled,adapter_validation_status,
      authentication_entry_url IS NOT NULL login_url,
      registration_entry_url IS NOT NULL registration_url,
      bidder_area_url IS NOT NULL bidder_area_url,
      last_verified_at,last_successful_login_at,last_successful_document_fetch_at,last_error_code
    FROM tender.portal_registry ORDER BY canonical_domain,display_name`);

  const adapterInventory = tableSet.has("portal_adapters") ? await rows(`SELECT portal_code,mode,
      kill_switch,last_success_at
    FROM tender.portal_adapters ORDER BY portal_code`) : [];

  const capabilityMatrix = tableSet.has("portal_capability_features") ? await rows(`SELECT portal.id portal_id,
      portal.display_name,portal.canonical_domain,portal.portal_family_key,feature.feature_key,
      feature.portal_support,feature.autopilot_supported,feature.actively_configured,
      feature.production_tested,feature.browser_acceptance_passed
    FROM tender.portal_capability_features feature
    JOIN tender.portal_capability_profiles profile ON profile.id=feature.profile_id
    JOIN tender.portal_registry portal ON portal.id=profile.portal_id
    ORDER BY portal.canonical_domain,feature.feature_key`) : [];

  const credentialSummary = await rows(`SELECT status,account_type,read_only,submission_capable,
      count(*)::int count,
      count(*) FILTER(WHERE ciphertext IS NOT NULL AND iv IS NOT NULL AND auth_tag IS NOT NULL)::int encrypted,
      count(*) FILTER(WHERE bound_host IS NULL OR authorized_capabilities IS NULL)::int incomplete_scope,
      count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM tender.portal_credential_companies company_scope
        WHERE company_scope.credential_id=portal_credential_secrets.id AND company_scope.active))::int unbound
    FROM tender.portal_credential_secrets
    GROUP BY status,account_type,read_only,submission_capable
    ORDER BY status,account_type`);

  const counts = {};
  for (const table of [
    "tenders", "tender_versions", "lots", "tender_lot_lifecycles", "source_references",
    "tender_external_links", "tender_portal_resolutions", "tender_portal_assignments",
    "enrichment_versions", "enrichment_lots", "enrichment_context_bindings", "pipeline_contexts",
    "enrichment_documents", "calculations", "required_documents", "bid_packages", "approval_requests",
    "submission_contexts", "submission_jobs", "submission_receipts",
  ]) counts[table] = tableSet.has(table) ? await scalar(`SELECT count(*) FROM tender.${table}`) : null;

  const contextDefects = {
    activeTendersWithoutVersion: await scalar(`SELECT count(*) FROM tender.tenders tender
      WHERE tender.source_lifecycle_status='ACTIVE' AND NOT EXISTS(
        SELECT 1 FROM tender.tender_versions version WHERE version.tender_id=tender.id)`),
    activeTendersWithoutCanonicalLot: await scalar(`SELECT count(*) FROM tender.tenders tender
      WHERE tender.source_lifecycle_status='ACTIVE' AND NOT EXISTS(
        SELECT 1 FROM tender.lots lot WHERE lot.tender_id=tender.id)`),
    enrichmentLotsWithoutCanonicalLot: await scalar(`SELECT count(*) FROM tender.enrichment_lots enrichment_lot
      JOIN tender.enrichment_versions version ON version.id=enrichment_lot.enrichment_version_id
      WHERE NOT EXISTS(SELECT 1 FROM tender.lots lot
        WHERE lot.tender_id=version.tender_id AND lot.external_id=enrichment_lot.lot_key)`),
    documentsWithCrossVersionLot: await scalar(`SELECT count(*) FROM tender.enrichment_documents document
      JOIN tender.enrichment_lots lot ON lot.id=document.lot_id
      WHERE lot.enrichment_version_id<>document.enrichment_version_id`),
    pipelineContextLotIdColumnMissing: tableSet.has("pipeline_contexts") && !hasColumn("pipeline_contexts", "lot_id"),
    pipelineContextEnrichmentVersionIdColumnMissing: tableSet.has("pipeline_contexts") && !hasColumn("pipeline_contexts", "enrichment_version_id"),
    pipelineContextsMissingLotRaw: hasColumn("pipeline_contexts", "lot_id") ? await scalar(`SELECT count(*) FROM tender.pipeline_contexts
      WHERE lot_id IS NULL`) : null,
    pipelineContextsMissingEnrichmentVersionRaw: hasColumn("pipeline_contexts", "enrichment_version_id") ? await scalar(`SELECT count(*) FROM tender.pipeline_contexts
      WHERE enrichment_version_id IS NULL`) : null,
    pipelineContextsMissingLot: hasColumn("pipeline_contexts", "context_integrity_status") ? await scalar(`SELECT count(*) FROM tender.pipeline_contexts
      WHERE context_integrity_status='REPAIR_REQUIRED' AND lot_id IS NULL`) : null,
    pipelineContextsMissingEnrichmentVersion: hasColumn("pipeline_contexts", "context_integrity_status") ? await scalar(`SELECT count(*) FROM tender.pipeline_contexts
      WHERE context_integrity_status='REPAIR_REQUIRED' AND enrichment_version_id IS NULL`) : null,
    pipelineContextsHistorical: hasColumn("pipeline_contexts", "context_integrity_status") ? await scalar(`SELECT count(*) FROM tender.pipeline_contexts
      WHERE context_integrity_status='HISTORICAL_SOURCE'`) : null,
    pipelineContextsTenderGlobal: hasColumn("pipeline_contexts", "context_integrity_status") ? await scalar(`SELECT count(*) FROM tender.pipeline_contexts
      WHERE context_integrity_status='TENDER_GLOBAL'`) : null,
    pipelineContextsCanonical: hasColumn("pipeline_contexts", "context_integrity_status") ? await scalar(`SELECT count(*) FROM tender.pipeline_contexts
      WHERE context_integrity_status='CANONICAL'`) : null,
    pipelineContextsInvalidLot: hasColumn("pipeline_contexts", "lot_id") ? await scalar(`SELECT count(*) FROM tender.pipeline_contexts context
      LEFT JOIN tender.lots lot ON lot.id=context.lot_id AND lot.tender_id=context.tender_id
      WHERE context.lot_id IS NOT NULL AND lot.id IS NULL`) : null,
    pipelineContextsInvalidEnrichmentVersion: hasColumn("pipeline_contexts", "enrichment_version_id") ? await scalar(`SELECT count(*) FROM tender.pipeline_contexts context
      LEFT JOIN tender.enrichment_versions version ON version.id=context.enrichment_version_id AND version.tender_id=context.tender_id
      WHERE context.enrichment_version_id IS NOT NULL AND version.id IS NULL`) : null,
  };

  const documentTruth = await rows(`SELECT
      count(*) FILTER(WHERE procurement_relevant)::int expected_or_relevant,
      count(*) FILTER(WHERE procurement_relevant AND content IS NOT NULL AND payload_sha256 IS NOT NULL)::int downloaded,
      count(*) FILTER(WHERE procurement_relevant AND procurement_verification_status='VERIFIED')::int verified,
      count(*) FILTER(WHERE procurement_relevant AND (content IS NULL OR payload_sha256 IS NULL))::int missing_payload,
      count(*) FILTER(WHERE procurement_relevant AND procurement_verification_status IS DISTINCT FROM 'VERIFIED')::int unverified,
      count(*) FILTER(WHERE procurement_relevant AND lot_id IS NULL)::int without_lot
    FROM tender.enrichment_documents`);

  const rls = await rows(`SELECT table_name,row_security,force_row_security,
      coalesce(array_agg(policy_name ORDER BY policy_name) FILTER(WHERE policy_name IS NOT NULL),ARRAY[]::text[]) policies
    FROM (
      SELECT class.relname table_name,class.relrowsecurity row_security,class.relforcerowsecurity force_row_security,
        policy.polname policy_name
      FROM pg_class class JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
      LEFT JOIN pg_policy policy ON policy.polrelid=class.oid
      WHERE namespace.nspname='tender' AND class.relkind='r'
        AND class.relname ~ '(company|credential|session|calculation|document|required|approval|package|submission|context)'
    ) scoped GROUP BY table_name,row_security,force_row_security ORDER BY table_name`);

  const submissionSafety = tableSet.has("submission_runtime_settings")
    ? await rows(`SELECT external_submission_enabled,allow_external_submission,global_kill_switch
      FROM tender.submission_runtime_settings`)
    : [];
  const transmittedColumns = await rows(`SELECT table_name FROM information_schema.columns
    WHERE table_schema='tender' AND column_name='transmitted' ORDER BY table_name`);
  const transmitted = {};
  for (const { table_name } of transmittedColumns) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table_name)) throw new Error("unsafe_table_name");
    transmitted[table_name] = await scalar(`SELECT count(*) FROM tender.${table_name} WHERE transmitted IS TRUE`);
  }

  await client.query("ROLLBACK");
  console.log(JSON.stringify({
    capturedAt: new Date().toISOString(), transaction: "READ_ONLY_ROLLED_BACK",
    tableCount: tables.length, selectedColumns, companies, companyProfiles, portalRegistry,
    adapterInventory, capabilityMatrix, credentialSummary, counts, contextDefects,
    documentTruth, rls, submissionSafety, transmitted,
  }, null, 2));
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.release();
  await rawPool.end();
}
