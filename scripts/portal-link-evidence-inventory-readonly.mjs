import fs from "node:fs";
import pg from "pg";
import { loadTenderLinkEvidence } from "../platform/tender-link-evidence.mjs";

const pool = new pg.Pool({
  connectionString: fs.readFileSync(process.env.DATABASE_URL_FILE || "/run/secrets/database_url", "utf8").trim(),
  max: 1,
  options: "-c default_transaction_read_only=on -c statement_timeout=55000",
});

try {
  const rows = (await pool.query(`WITH scope AS(
      SELECT configuration.company_id,configuration.canonical_service,company.legal_name
      FROM tender.configuration_scopes configuration
      JOIN tender.enterprise_company_links company ON company.company_id=configuration.company_id AND company.tender_profile_id=configuration.profile_id
    ), stable_regions AS(
      SELECT DISTINCT ON(evaluation.tender_id,evaluation.company_id) evaluation.tender_id,evaluation.company_id
      FROM tender.region_evaluations evaluation
      WHERE evaluation.lot_id IS NULL AND evaluation.source_data->>'pipelineVersion'='wb-daily-inbox-pipeline/1.0.0'
      ORDER BY evaluation.tender_id,evaluation.company_id,evaluation.evaluation_version DESC
    )
    SELECT region.tender_id,scope.company_id,scope.legal_name,scope.canonical_service,tender.source_code
    FROM stable_regions region JOIN scope ON scope.company_id=region.company_id
    JOIN tender.tenders tender ON tender.id=region.tender_id AND tender.data_class='PUBLIC_REAL'
    ORDER BY scope.legal_name,scope.canonical_service,tender.source_code,region.tender_id`)).rows;
  const evidence = new Map();
  const ids = [...new Set(rows.map((row) => String(row.tender_id)))];
  for (let index = 0; index < ids.length; index += 250) {
    for (const [id, item] of await loadTenderLinkEvidence(pool, ids.slice(index, index + 250))) evidence.set(id, item);
  }
  const groups = new Map(), recognizedHosts = new Set(), reasons = {};
  const counters = () => ({ total:0, originalNotice:0, procurementPortal:0, documentLinks:0, technicalSource:0, login:0, registration:0, electronicSubmission:0, manualReview:0, multiplePortalHosts:0 });
  const total = counters();
  for (const row of rows) {
    const key = `${row.legal_name}|${row.canonical_service}|${row.source_code}`;
    if (!groups.has(key)) groups.set(key, { company:row.legal_name, canonicalService:row.canonical_service, source:row.source_code, ...counters() });
    const item = evidence.get(String(row.tender_id));
    for (const target of [total, groups.get(key)]) {
      target.total++;
      if (item?.originalNotice) target.originalNotice++;
      if (item?.procurementPortal) target.procurementPortal++;
      target.documentLinks += item?.documents?.length || 0;
      if (item?.technicalSource) target.technicalSource++;
      if (item?.login) target.login++;
      if (item?.registration) target.registration++;
      if (item?.electronicSubmission) target.electronicSubmission++;
      if (item?.portalMapping?.status !== "EINDEUTIG_ZUGEORDNET") target.manualReview++;
      if (item?.portalMapping?.reason === "Mehrere mögliche Portalhosts") target.multiplePortalHosts++;
    }
    if (item?.procurementPortal?.canonicalHost) recognizedHosts.add(item.procurementPortal.canonicalHost);
    const reason = item?.portalMapping?.reason || "EINDEUTIG_ZUGEORDNET";
    reasons[reason] = (reasons[reason] || 0) + 1;
  }
  console.log(JSON.stringify({ readOnly:true, capturedAt:new Date().toISOString(), stableMaterialization:"wb-daily-inbox-pipeline/1.0.0", uniqueTenders:ids.length, tenderCompanyScopes:rows.length, recognizedPortalHosts:[...recognizedHosts].sort(), totals:total, mappingReasons:reasons, groups:[...groups.values()] }, null, 2));
} finally {
  await pool.end();
}
