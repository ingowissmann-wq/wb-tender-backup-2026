import fs from "node:fs";
import pg from "pg";
import { loadTenderLinkEvidence, safeExternalHttpsUrl } from "../platform/tender-link-evidence.mjs";

const databaseUrlFile = process.env.DATABASE_URL_FILE || "/run/secrets/database_url";
if (!fs.existsSync(databaseUrlFile)) throw new Error("database_url_file_missing");
const pool = new pg.Pool({
  connectionString: fs.readFileSync(databaseUrlFile, "utf8").trim(),
  max: 1,
  options: "-c default_transaction_read_only=on -c statement_timeout=55000",
});

try {
  const hasConfigurationScopes = Boolean((await pool.query("SELECT to_regclass('tender.configuration_scopes') name")).rows[0]?.name);
  const samples = hasConfigurationScopes ? (await pool.query(`WITH scope AS(
      SELECT s.company_id,s.canonical_service,c.legal_name,
        CASE s.canonical_service WHEN 'facility_management' THEN 'facility-management' WHEN 'emergency_services' THEN 'emergency-services' ELSE s.canonical_service END service_line
      FROM tender.configuration_scopes s JOIN tender.enterprise_company_links c ON c.company_id=s.company_id AND c.tender_profile_id=s.profile_id
    ), stable_regions AS(
      SELECT DISTINCT ON(e.tender_id,e.company_id) e.tender_id,e.company_id
      FROM tender.region_evaluations e
      WHERE e.lot_id IS NULL AND e.source_data->>'pipelineVersion'='wb-daily-inbox-pipeline/1.0.0'
      ORDER BY e.tender_id,e.company_id,e.evaluation_version DESC
    ) SELECT DISTINCT ON(scope.company_id,scope.canonical_service,t.source_code)
      scope.company_id,scope.legal_name,scope.canonical_service,t.id tender_id,t.source_code,t.external_id
    FROM stable_regions region JOIN scope ON scope.company_id=region.company_id
    JOIN tender.tenders t ON t.id=region.tender_id AND t.data_class='PUBLIC_REAL' AND t.source_code IN('DOE','TED')
    ORDER BY scope.company_id,scope.canonical_service,t.source_code,t.publication_date DESC NULLS LAST,t.id`)).rows : (await pool.query(`SELECT DISTINCT ON(t.source_code)
      NULL::uuid company_id,'Isolierter DOE-/TED-Fixture-Klon' legal_name,'fixture_wide' canonical_service,
      t.id tender_id,t.source_code,t.external_id
      FROM tender.tenders t WHERE t.data_class='PUBLIC_REAL' AND t.source_code IN('DOE','TED')
      ORDER BY t.source_code,EXISTS(SELECT 1 FROM tender.tender_versions version WHERE version.tender_id=t.id AND version.normalized_data::text ILIKE '%meinauftrag.rib.de%') DESC,t.publication_date DESC NULLS LAST,t.id`)).rows;
  const evidence = await loadTenderLinkEvidence(pool, samples.map((sample) => sample.tender_id));
  const results = samples.map((sample) => {
    const item = evidence.get(String(sample.tender_id)), links = [
      item?.originalNotice,
      item?.procurementPortal,
      ...(item?.documents || []),
      item?.login,
      item?.registration,
      item?.technicalSource,
      item?.electronicSubmission,
    ].filter(Boolean);
    return {
      companyId: sample.company_id,
      company: sample.legal_name,
      canonicalService: sample.canonical_service,
      source: sample.source_code,
      externalId: sample.external_id,
      originalNotice: Boolean(item?.originalNotice),
      procurementPortal: Boolean(item?.procurementPortal),
      procurementPortalName: item?.procurementPortal?.portalName || null,
      procurementPortalHost: item?.procurementPortal?.canonicalHost || null,
      documentLinks: item?.documents?.length || 0,
      login: Boolean(item?.login),
      registration: Boolean(item?.registration),
      technicalSource: Boolean(item?.technicalSource),
      electronicSubmission: Boolean(item?.electronicSubmission),
      portalReason: item?.missingReasons?.procurementPortal || null,
      documentStatus: item?.documentEvidence?.code || null,
      unsafeLinks: links.filter((link) => safeExternalHttpsUrl(link.url) !== link.url).length,
    };
  });
  const passed = Boolean(results.length) && !results.some((result) => result.unsafeLinks || (result.source === "TED" && !result.originalNotice) || (result.source === "DOE" && (!result.technicalSource || result.originalNotice)));
  console.log(JSON.stringify({ passed, readOnly: true, sampleCount: results.length, results }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  await pool.end();
}
