import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { buildLifecyclePlan, canonicalJson, loadLifecycleRows, sha256 } from "../platform/lifecycle-plan.mjs";

const readJson = (path) => path ? JSON.parse(readFileSync(path, "utf8")) : [];
const relationEvidence = readJson(process.env.NOTICE_RELATION_EVIDENCE_FILE);
const deadlineEvidence = readJson(process.env.NOTICE_DEADLINE_EVIDENCE_FILE);
const connectionString = process.env.DATABASE_URL || readFileSync(process.env.DATABASE_URL_FILE || "/run/secrets/database_url", "utf8").trim();
const pool = new pg.Pool({ connectionString, max: 1, options: "-c default_transaction_read_only=on -c statement_timeout=0" }), client = await pool.connect();
const countBy = (rows, key) => Object.entries(rows.reduce((out, row) => { const value = typeof key === "function" ? key(row) : row[key]; out[value ?? "(null)"] = (out[value ?? "(null)"] || 0) + 1; return out; }, {})).sort(([a], [b]) => a.localeCompare(b)).map(([category, count]) => ({ category, count }));
try {
  await client.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
  const configured = process.env.NOTICE_LIFECYCLE_AS_OF;
  if (!configured) throw new Error("NOTICE_LIFECYCLE_AS_OF is required for a reproducible release gate");
  const asOf = new Date(configured);
  if (Number.isNaN(asOf.getTime())) throw new Error("NOTICE_LIFECYCLE_AS_OF must be a valid ISO-8601 timestamp");
  const sourceRows = await loadLifecycleRows(client), plan = buildLifecyclePlan(sourceRows, { asOf, relationEvidence, deadlineEvidence });
  if (process.env.NOTICE_PLAN_MANIFEST_FILE) writeFileSync(process.env.NOTICE_PLAN_MANIFEST_FILE, canonicalJson(plan.planDocument), { flag: "wx", mode: 0o600 });
  const active = plan.rows.filter((row) => row.toLifecycle === "ACTIVE" && ["ELIGIBLE", "PARTIALLY_ELIGIBLE"].includes(row.toParticipation));
  const planById = new Map(plan.rows.map((row) => [row.id, row]));
  const companyNames = (await client.query("SELECT legal_name FROM tender.enterprise_company_links WHERE active ORDER BY legal_name")).rows.map((row) => row.legal_name);
  const contextRows = (await client.query(`SELECT DISTINCT ON(r.tender_id,r.company_id,coalesce(r.lot_key,''))
      r.tender_id,r.company_id,r.lot_key,r.service_line,company.legal_name,region.classification
    FROM tender.current_service_relevance r JOIN tender.enterprise_company_links company ON company.company_id=r.company_id AND company.active
    JOIN tender.configuration_scopes scope ON scope.company_id=r.company_id AND scope.profile_id=company.tender_profile_id
      AND scope.canonical_service=CASE r.service_line WHEN 'facility-management' THEN 'facility_management' WHEN 'emergency-services' THEN 'emergency_services' ELSE r.service_line END
    LEFT JOIN LATERAL(SELECT classification FROM tender.region_evaluations e WHERE e.tender_id=r.tender_id AND e.company_id=r.company_id AND e.lot_id IS NULL ORDER BY e.evaluation_version DESC LIMIT 1)region ON true
    WHERE r.relevance_status='RELEVANT' AND r.primary_company=true AND r.service_scope_gate='PASSED'
    ORDER BY r.tender_id,r.company_id,coalesce(r.lot_key,''),r.evaluation_version DESC`)).rows;
  const companyRows = companyNames.map((legalName) => {
    const contexts = contextRows.filter((row) => row.legal_name === legalName), output = { legal_name: legalName, total: contexts.length, core: 0, strategic: 0, outside: 0, excluded: 0, unresolved: 0, completed: 0, review: 0, active_eligible: 0, partially_eligible: 0 };
    for (const context of contexts) {
      const target = planById.get(context.tender_id);
      if (context.classification === "CORE_REGION") output.core++;
      else if (context.classification === "STRATEGIC_REGION") output.strategic++;
      else if (context.classification === "OUTSIDE_CORE_REGION") output.outside++;
      else if (context.classification === "EXCLUDED_REGION") output.excluded++;
      else output.unresolved++;
      if (["CLOSED","WITHDRAWN","EXPIRED"].includes(target?.toLifecycle)) output.completed++;
      else if (target?.toLifecycle === "REVIEW_REQUIRED") output.review++;
      else if (target?.toLifecycle === "ACTIVE") {
        output.active_eligible++;
        if (target.toParticipation === "PARTIALLY_ELIGIBLE") output.partially_eligible++;
      }
    }
    return output;
  });
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
  const distinctDeadlineCases = plan.rows.filter((row) => new Set((sourceById.get(row.id)?.normalized_data?.raw?.["deadline-receipt-tender-date-lot"] || [])).size > 1);
  const mixedLots = plan.rows.filter((row) => row.lots.some((lot) => lot.lifecycleStatus === "ACTIVE") && row.lots.some((lot) => lot.lifecycleStatus !== "ACTIVE"));
  const result = {
    mode: "READ_ONLY_RELEASE_GATE", canonicalPlanSchema: plan.planDocument.schema, asOf: asOf.toISOString(),
    productionRows: sourceRows.length, reconciledRows: plan.rows.length, unexplainedRows: sourceRows.length - plan.rows.length,
    planSha256: plan.planSha256, inputSha256: plan.inputSha256,
    reconciliation: countBy(plan.rows, (row) => `${row.source}|${row.classification}|${row.fromLifecycle}->${row.toLifecycle}|${row.fromParticipation || "NULL"}->${row.toParticipation}|${row.deadlineQuality}`),
    futureLifecycle: countBy(plan.rows, (row) => `${row.toLifecycle}|${row.toParticipation}`),
    deadlineQuality: countBy(plan.rows, "deadlineQuality"),
    lotLifecycle: countBy(plan.rows.flatMap((row) => row.lots), (lot) => `${lot.lifecycleStatus}|${lot.participationStatus}|${lot.deadlineQuality}`),
    uniqueTenders: plan.rows.length, uniqueNotices: new Set(plan.rows.map((row) => `${row.source}:${row.externalId}`)).size,
    procedures: new Set(plan.rows.map((row) => `${row.source}:${row.procedureIdentifier}`).filter((value) => !value.endsWith(":null"))).size,
    lots: plan.rows.reduce((total, row) => total + row.lots.length, 0),
    activeTenderCount: active.length, partiallyEligibleTenderCount: active.filter((row) => row.toParticipation === "PARTIALLY_ELIGIBLE").length,
    managementCompanies: companyRows,
    companyTenderContexts: new Set(contextRows.map((row) => `${row.company_id}:${row.tender_id}`)).size,
    companyLotContexts: contextRows.length,
    differentLotDeadlineCases: distinctDeadlineCases.length,
    mixedLotCases: mixedLots.length,
    differentLotDeadlineAudit: distinctDeadlineCases.map((row) => ({ noticeHash: sha256(`${row.source}:${row.externalId}`).slice(0, 16), source: row.source, evidenceCount: row.deadlineEvidence.length, lotCount: row.lots.length, deadlineQuality: row.deadlineQuality, target: `${row.toLifecycle}/${row.toParticipation}`, reasons: [...new Set(row.lots.map((lot) => lot.blockReason).filter(Boolean))] })),
    references: plan.rows.filter((row) => ["574224-2026", "377489-2026"].includes(row.externalId)).map((row) => ({ externalId: row.externalId, classification: row.classification, target: `${row.toLifecycle}/${row.toParticipation}`, lots: row.lots })),
    submissionGate: { externalSubmission: false, httpStatus: 423 }, physicalDeletes: 0,
  };
  await client.query("ROLLBACK");
  if (process.env.RELEASE_GATE_OUTPUT_FILE) writeFileSync(process.env.RELEASE_GATE_OUTPUT_FILE, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
} catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
finally { client.release(); await pool.end(); }
