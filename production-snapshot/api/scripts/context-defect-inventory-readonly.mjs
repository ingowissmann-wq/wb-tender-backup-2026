import fs from "node:fs";
import pg from "pg";
import { createFixedScopedPool, loadBackgroundScope } from "../platform/scoped-pg-pool.mjs";

const connectionString=process.env.DATABASE_URL||fs.readFileSync(
  process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8",
).trim();
const rawPool=new pg.Pool({connectionString,max:1,options:["-c default_transaction_read_only=on -c statement_timeout=120000",process.env.DATABASE_SESSION_OPTIONS].filter(Boolean).join(" ")});
const pool=createFixedScopedPool(rawPool,await loadBackgroundScope(rawPool)).pool;
const client=await pool.connect();

try{
  await client.query("BEGIN READ ONLY");
  const activeTenderLotDefects=(await client.query(`SELECT
      count(*)::int active_without_canonical_lot,
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM tender.tender_lot_lifecycles lifecycle
        WHERE lifecycle.tender_id=tender.id AND lifecycle.is_current
          AND lifecycle.lot_key IS NOT NULL AND btrim(lifecycle.lot_key)<>''))::int repairable_from_current_lifecycle,
      count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM tender.tender_lot_lifecycles lifecycle
        WHERE lifecycle.tender_id=tender.id AND lifecycle.is_current
          AND lifecycle.lot_key IS NOT NULL AND btrim(lifecycle.lot_key)<>'')
        AND EXISTS(SELECT 1 FROM tender.enrichment_versions version
          JOIN tender.enrichment_lots lot ON lot.enrichment_version_id=version.id
          WHERE version.tender_id=tender.id AND version.historical=false
            AND lot.lot_key IS NOT NULL AND btrim(lot.lot_key)<>''))::int enrichment_only_lot_evidence,
      count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM tender.tender_lot_lifecycles lifecycle
        WHERE lifecycle.tender_id=tender.id AND lifecycle.is_current
          AND lifecycle.lot_key IS NOT NULL AND btrim(lifecycle.lot_key)<>'')
        AND NOT EXISTS(SELECT 1 FROM tender.enrichment_versions version
          JOIN tender.enrichment_lots lot ON lot.enrichment_version_id=version.id
          WHERE version.tender_id=tender.id AND version.historical=false
            AND lot.lot_key IS NOT NULL AND btrim(lot.lot_key)<>''))::int no_canonical_lot_evidence
    FROM tender.tenders tender
    WHERE tender.source_lifecycle_status='ACTIVE'
      AND NOT EXISTS(SELECT 1 FROM tender.lots lot WHERE lot.tender_id=tender.id)`)).rows[0];
  const enrichmentLotDefects=(await client.query(`SELECT count(*)::int missing_canonical_lot,
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM tender.tender_lot_lifecycles lifecycle
        WHERE lifecycle.tender_id=version.tender_id AND lifecycle.lot_key=enrichment_lot.lot_key
          AND lifecycle.is_current))::int repairable_from_current_lifecycle,
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM tender.tender_lot_lifecycles lifecycle
        WHERE lifecycle.tender_id=version.tender_id AND lifecycle.lot_key=enrichment_lot.lot_key)
        AND NOT EXISTS(SELECT 1 FROM tender.tender_lot_lifecycles lifecycle
          WHERE lifecycle.tender_id=version.tender_id AND lifecycle.lot_key=enrichment_lot.lot_key
            AND lifecycle.is_current))::int historical_lifecycle_only,
      count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM tender.tender_lot_lifecycles lifecycle
        WHERE lifecycle.tender_id=version.tender_id AND lifecycle.lot_key=enrichment_lot.lot_key))::int enrichment_only
    FROM tender.enrichment_lots enrichment_lot
    JOIN tender.enrichment_versions version ON version.id=enrichment_lot.enrichment_version_id
    WHERE NOT EXISTS(SELECT 1 FROM tender.lots canonical
      WHERE canonical.tender_id=version.tender_id AND canonical.external_id=enrichment_lot.lot_key)`)).rows[0];
  const pipelineContexts=(await client.query(`SELECT count(*)::int total,
      count(*) FILTER(WHERE lot_key='')::int tender_global,
      count(*) FILTER(WHERE lot_key<>'' AND EXISTS(SELECT 1 FROM tender.lots lot
        WHERE lot.tender_id=context.tender_id AND lot.external_id=context.lot_key))::int exact_canonical_lot,
      count(*) FILTER(WHERE lot_key<>'' AND NOT EXISTS(SELECT 1 FROM tender.lots lot
        WHERE lot.tender_id=context.tender_id AND lot.external_id=context.lot_key))::int missing_canonical_lot,
      count(*) FILTER(WHERE lot_key<>'' AND NOT EXISTS(SELECT 1 FROM tender.lots lot
        WHERE lot.tender_id=context.tender_id AND lot.external_id=context.lot_key)
        AND EXISTS(SELECT 1 FROM tender.tender_lot_lifecycles lifecycle
          WHERE lifecycle.tender_id=context.tender_id AND lifecycle.lot_key=context.lot_key
            AND lifecycle.is_current))::int repairable_from_current_lifecycle,
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM tender.configuration_scopes scope
        JOIN tender.enterprise_company_links company ON company.company_id=scope.company_id
          AND company.tender_profile_id=scope.profile_id
        WHERE scope.company_id=context.company_id))::int exact_company_scope_available,
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM tender.enrichment_versions version
        WHERE version.tender_id=context.tender_id AND version.historical=false))::int current_enrichment_available
      ,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM tender.tenders tender
        WHERE tender.id=context.tender_id AND tender.source_lifecycle_status='ACTIVE'))::int active_tender_contexts
      ,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM tender.tenders tender
        WHERE tender.id=context.tender_id AND tender.source_lifecycle_status='ACTIVE')
        AND NOT EXISTS(SELECT 1 FROM tender.enrichment_versions version
          WHERE version.tender_id=context.tender_id AND version.historical=false))::int active_without_current_enrichment
    FROM tender.pipeline_contexts context`)).rows[0];
  const enrichmentOnlyActiveTenders=(await client.query(`SELECT tender.id tender_id,tender.source_code,
      tender.external_id,tender.title,tender.offer_deadline,tender.participation_deadline,
      array_agg(DISTINCT lot.lot_key ORDER BY lot.lot_key) lot_keys,
      count(DISTINCT version.id)::int current_enrichment_versions
    FROM tender.tenders tender
    JOIN tender.enrichment_versions version ON version.tender_id=tender.id AND version.historical=false
    JOIN tender.enrichment_lots lot ON lot.enrichment_version_id=version.id
    WHERE tender.source_lifecycle_status='ACTIVE'
      AND NOT EXISTS(SELECT 1 FROM tender.lots canonical WHERE canonical.tender_id=tender.id)
      AND NOT EXISTS(SELECT 1 FROM tender.tender_lot_lifecycles lifecycle
        WHERE lifecycle.tender_id=tender.id AND lifecycle.is_current
          AND lifecycle.lot_key IS NOT NULL AND btrim(lifecycle.lot_key)<>'')
    GROUP BY tender.id,tender.source_code,tender.external_id,tender.title,
      tender.offer_deadline,tender.participation_deadline ORDER BY tender.source_code,tender.external_id`)).rows;
  const predictedPipelineIntegrity=(await client.query(`WITH virtual_lots AS(
      SELECT lot.tender_id,lot.external_id lot_key,lot.id lot_id FROM tender.lots lot
      UNION ALL
      SELECT lifecycle.tender_id,lifecycle.lot_key,NULL::uuid
      FROM tender.tender_lot_lifecycles lifecycle
      WHERE lifecycle.is_current AND lifecycle.lot_key IS NOT NULL AND btrim(lifecycle.lot_key)<>''
        AND NOT EXISTS(SELECT 1 FROM tender.lots lot
          WHERE lot.tender_id=lifecycle.tender_id AND lot.external_id=lifecycle.lot_key)
      UNION ALL
      SELECT fixture.tender_id,'LOT-ACCEPTANCE-001',NULL::uuid
      FROM tender.internal_acceptance_fixtures fixture
      WHERE NOT EXISTS(SELECT 1 FROM tender.lots lot
        WHERE lot.tender_id=fixture.tender_id AND lot.external_id='LOT-ACCEPTANCE-001')
    ), classified AS(
      SELECT context.id,CASE
        WHEN tender.source_lifecycle_status<>'ACTIVE' THEN 'HISTORICAL_SOURCE'
        WHEN binding.tenant_id IS NULL THEN 'TENANT_BINDING_MISSING'
        WHEN context.lot_key='' AND enrichment.id IS NULL THEN 'CURRENT_ENRICHMENT_MISSING'
        WHEN context.lot_key='' THEN 'TENDER_GLOBAL'
        WHEN lot.lot_key IS NULL THEN 'CANONICAL_LOT_MISSING'
        WHEN exact_binding.id IS NULL THEN 'EXACT_ENRICHMENT_BINDING_MISSING'
        ELSE 'CANONICAL' END predicted_status
      FROM tender.pipeline_contexts context
      JOIN tender.tenders tender ON tender.id=context.tender_id
      LEFT JOIN saas.legacy_company_tenant_bindings binding ON binding.company_id=context.company_id
      LEFT JOIN virtual_lots lot ON lot.tender_id=context.tender_id AND lot.lot_key=context.lot_key
      LEFT JOIN LATERAL(SELECT version.id FROM tender.enrichment_versions version
        WHERE version.tender_id=context.tender_id AND version.historical=false
        ORDER BY version.version DESC LIMIT 1) enrichment ON true
      LEFT JOIN LATERAL(SELECT candidate.id FROM tender.enrichment_context_bindings candidate
        JOIN tender.enrichment_versions version ON version.id=candidate.enrichment_version_id AND version.historical=false
        WHERE candidate.tenant_id=binding.tenant_id AND candidate.company_id=context.company_id
          AND candidate.tender_id=context.tender_id AND candidate.source_lot_id=context.lot_key
        ORDER BY version.version DESC LIMIT 1) exact_binding ON context.lot_key<>''
    ) SELECT predicted_status,count(*)::int count FROM classified GROUP BY predicted_status ORDER BY count(*) DESC`)).rows;
  await client.query("ROLLBACK");
  console.log(JSON.stringify({capturedAt:new Date().toISOString(),transaction:"READ_ONLY_ROLLED_BACK",
    activeTenderLotDefects,enrichmentLotDefects,pipelineContexts,enrichmentOnlyActiveTenders,
    predictedPipelineIntegrity},null,2));
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{await client.release();await rawPool.end()}
