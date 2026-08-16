import fs from "node:fs";
import pg from "pg";

const connectionString =
  process.env.DATABASE_URL ||
  fs.readFileSync(process.env.DATABASE_URL_FILE || "/run/secrets/database_url", "utf8").trim();
const client = new pg.Client({ connectionString });
const scalar = async (sql, params = []) => Number((await client.query(sql, params)).rows[0].count);

await client.connect();
try {
  await client.query("BEGIN TRANSACTION READ ONLY");
  const transmittedColumns = (
    await client.query(`SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema='tender' AND column_name='transmitted' ORDER BY table_name`)
  ).rows;
  const transmitted = [];
  for (const column of transmittedColumns) {
    if (!/^[a-z_][a-z0-9_]*$/.test(column.table_name))
      throw new Error("unsafe_transmitted_table_name");
    transmitted.push({
      table: column.table_name,
      trueCount: await scalar(
        `SELECT count(*) FROM tender.${column.table_name} WHERE transmitted IS TRUE`,
      ),
    });
  }

  const checks = {
    transmittedTrue: transmitted.reduce((sum, item) => sum + item.trueCount, 0),
    invalidDocumentLotBindings: await scalar(`SELECT count(*) FROM tender.enrichment_documents d
      JOIN tender.enrichment_lots l ON l.id=d.lot_id
      WHERE l.enrichment_version_id<>d.enrichment_version_id`),
    generalPortalDocumentsCountedAsProcurement: await scalar(`SELECT count(*) FROM tender.enrichment_documents
      WHERE procurement_relevant AND document_class='GENERAL_PORTAL_DOCUMENT'`),
    verifiedProcurementDocumentsWithoutHash: await scalar(`SELECT count(*) FROM tender.enrichment_documents
      WHERE procurement_relevant AND procurement_verification_status='VERIFIED'
        AND (payload_sha256 IS NULL OR length(payload_sha256)<>64)`),
    verifiedProcurementDocumentsWithParserFailure: await scalar(`SELECT count(*) FROM tender.enrichment_documents
      WHERE procurement_relevant AND procurement_verification_status='VERIFIED'
        AND (fetch_status='PARSER_FEHLER' OR extracted_data ? 'error')`),
    successfulJobsWithStaleErrors: await scalar(`SELECT count(*) FROM tender.autopilot_queue
      WHERE status IN('SUCCEEDED','DONE') AND (safe_error_code IS NOT NULL OR error_detail_safe IS NOT NULL)`),
    duplicateActiveJobIdempotencyKeys: await scalar(`SELECT count(*) FROM (
      SELECT idempotency_key FROM tender.autopilot_queue
      WHERE idempotency_key IS NOT NULL AND status IN('QUEUED','CLAIMED','RUNNING','RETRY')
      GROUP BY idempotency_key HAVING count(*)>1) duplicate`),
    duplicateCalculationVersions: await scalar(`SELECT count(*) FROM (
      SELECT tender_id,company_id,coalesce(lot_key,''),version FROM tender.calculations
      GROUP BY tender_id,company_id,coalesce(lot_key,''),version HAVING count(*)>1) duplicate`),
    duplicateCurrentManagementOutputs: await scalar(`SELECT count(*) FROM (
      SELECT tender_id,company_id,coalesce(lot_key,''),calculation_id,document_revision
      FROM tender.management_outputs WHERE historical=false
      GROUP BY tender_id,company_id,coalesce(lot_key,''),calculation_id,document_revision
      HAVING count(*)>1) duplicate`),
    invalidCurrentGeneratedManagementOutputs: await scalar(`SELECT count(*) FROM tender.management_outputs m
      LEFT JOIN tender.calculations c ON c.id=m.calculation_id
      WHERE m.historical=false AND m.status='MANAGEMENT_OUTPUT_GENERATED' AND
        (c.id IS NULL OR c.tender_id<>m.tender_id OR c.company_id<>m.company_id
          OR coalesce(c.lot_key,'')<>coalesce(m.lot_key,''))`),
    duplicateCurrentFinalContexts: await scalar(`SELECT count(*) FROM (
      SELECT tender_id,company_id,coalesce(lot_key,'') FROM tender.final_preflight_contexts
      WHERE is_current GROUP BY tender_id,company_id,coalesce(lot_key,'') HAVING count(*)>1) duplicate`),
    invalidCurrentFinalScopeBindings: await scalar(`SELECT count(*) FROM tender.final_preflight_contexts f
      LEFT JOIN tender.calculations c ON c.id=f.calculation_id
      LEFT JOIN tender.management_outputs m ON m.id=f.management_output_id
      WHERE f.is_current AND (
        f.transmitted
        OR (c.id IS NOT NULL AND (c.tender_id<>f.tender_id OR c.company_id<>f.company_id
          OR coalesce(c.lot_key,'')<>coalesce(f.lot_key,'')))
        OR (m.id IS NOT NULL AND (m.tender_id<>f.tender_id OR m.company_id<>f.company_id
          OR coalesce(m.lot_key,'')<>coalesce(f.lot_key,'')))
        OR (c.id IS NOT NULL AND m.id IS NOT NULL AND m.calculation_id IS DISTINCT FROM c.id))`),
    approvedRequestsWithoutExactCalculation: await scalar(`SELECT count(*) FROM tender.approval_requests a
      LEFT JOIN tender.calculations c ON c.id=a.calculation_id
      WHERE a.status='APPROVED' AND (c.id IS NULL OR c.tender_id<>a.tender_id)`),
  };

  const documents = (
    await client.query(`SELECT
      count(*) FILTER(WHERE d.procurement_relevant)::int procurement_documents,
      count(*) FILTER(WHERE d.procurement_relevant AND d.fetch_status IN('VORHANDEN','DOWNLOAD_SUCCEEDED'))::int downloaded,
      count(*) FILTER(WHERE d.procurement_relevant AND d.procurement_verification_status='VERIFIED')::int verified,
      count(*) FILTER(WHERE d.procurement_relevant AND d.parser IS NOT NULL
        AND d.fetch_status<>'PARSER_FEHLER' AND d.extracted_data IS NOT NULL
        AND NOT(d.extracted_data ? 'error'))::int analyzed,
      count(DISTINCT d.enrichment_version_id) FILTER(WHERE d.procurement_relevant)::int enrichment_versions,
      count(DISTINCT v.tender_id) FILTER(WHERE d.procurement_relevant)::int real_tenders,
      count(*) FILTER(WHERE d.procurement_relevant AND lower(d.filename)~'\\.pdf$')::int pdf,
      count(*) FILTER(WHERE d.procurement_relevant AND lower(d.filename)~'\\.zip$')::int zip,
      count(*) FILTER(WHERE d.procurement_relevant AND lower(d.filename)~'\\.(xlsx|xls|ods)$')::int spreadsheet,
      count(*) FILTER(WHERE d.procurement_relevant AND lower(d.filename)~'\\.(x8[0-9]|d8[0-9]|p8[0-9]|gaeb)$')::int gaeb,
      count(*) FILTER(WHERE d.procurement_relevant AND lower(d.filename)~'\\.xml$')::int xml
      FROM tender.enrichment_documents d
      JOIN tender.enrichment_versions v ON v.id=d.enrichment_version_id
      JOIN tender.tenders t ON t.id=v.tender_id AND t.data_class='PUBLIC_REAL'`)
  ).rows[0];
  const pipeline = (
    await client.query(`SELECT
      (SELECT count(*)::int FROM tender.calculations c JOIN tender.tenders t ON t.id=c.tender_id AND t.data_class='PUBLIC_REAL') calculations,
      (SELECT count(DISTINCT(c.tender_id,c.company_id,coalesce(c.lot_key,'')))::int FROM tender.calculations c JOIN tender.tenders t ON t.id=c.tender_id AND t.data_class='PUBLIC_REAL') calculated_contexts,
      (SELECT count(*)::int FROM tender.management_outputs m JOIN tender.tenders t ON t.id=m.tender_id AND t.data_class='PUBLIC_REAL' WHERE NOT m.historical) current_management_outputs,
      (SELECT count(*)::int FROM tender.approval_requests a JOIN tender.tenders t ON t.id=a.tender_id AND t.data_class='PUBLIC_REAL') approval_requests,
      (SELECT count(*)::int FROM tender.final_preflight_contexts f JOIN tender.tenders t ON t.id=f.tender_id AND t.data_class='PUBLIC_REAL' WHERE f.is_current) current_final_contexts,
      (SELECT count(*)::int FROM tender.internal_acceptance_fixtures WHERE completed_at IS NOT NULL AND transmitted=false) completed_internal_acceptance_fixtures`)
  ).rows[0];
  const queue = (
    await client.query(`SELECT status,count(*)::int count FROM tender.autopilot_queue GROUP BY status ORDER BY status`)
  ).rows;
  const portals = (
    await client.query(`SELECT count(*)::int profiles,
      count(*) FILTER(WHERE adapter_enabled)::int adapter_enabled,
      count(*) FILTER(WHERE adapter_validation_status='PRODUCTION_VALIDATED')::int production_validated
      FROM tender.portal_registry`)
  ).rows[0];
  const deutscheEvergabe = (
    await client.query(`SELECT f.feature_key,f.portal_support,f.autopilot_supported,
      f.actively_configured,f.production_tested,f.browser_acceptance_passed
      FROM tender.portal_capability_features f
      JOIN tender.portal_capability_profiles p ON p.id=f.profile_id
      JOIN tender.portal_registry r ON r.id=p.portal_id
      WHERE r.adapter_id='deutsche-evergabe' ORDER BY f.feature_key`)
  ).rows;
  const violations = Object.entries(checks)
    .filter(([, count]) => count !== 0)
    .map(([name, count]) => ({ name, count }));
  console.log(
    JSON.stringify(
      {
        passed: violations.length === 0,
        transaction: "READ_ONLY_ROLLED_BACK",
        checks,
        transmittedColumns: transmitted,
        documents,
        pipeline,
        queue,
        portals,
        deutscheEvergabe,
        violations,
        externalSubmission: false,
        transmitted: false,
      },
      null,
      2,
    ),
  );
  await client.query("ROLLBACK");
  if (violations.length) process.exitCode = 1;
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.end();
}
