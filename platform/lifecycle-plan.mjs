import crypto from "node:crypto";
import { classifyNotice, noticeRelationships } from "./notice-lifecycle.mjs";
import { aggregateLotLifecycle, assessLotDeadlines, parseAuthoritativeDeadline, tedSearchDeadlineEvidence } from "./tender-deadlines.mjs";

export const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === "object" && !(value instanceof Date)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value instanceof Date ? value.toISOString() : value;
export const canonicalJson = (value) => JSON.stringify(canonicalize(value));
export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const unique = (values) => [...new Set((values || []).flat().filter(Boolean).map(String))];
const tags = (raw) => Array.isArray(raw?.tag) ? raw.tag.map(String) : raw?.tag ? [String(raw.tag)] : [];

function noticeFields(row, relationEvidence) {
  const normalized = row.normalized_data || {}, raw = normalized.raw || {}, override = relationEvidence.get(`${row.source_code}:${row.external_id}`) || {};
  const noticeType = row.source_code === "TED" ? raw["notice-type"] || normalized.noticeType || normalized.sourceStatus : normalized.noticeType;
  return {
    noticeType: noticeType || null,
    noticeSubtype: override.noticeSubtype || raw["notice-subtype"] || normalized.noticeSubtype || null,
    formType: override.formType || raw["form-type"] || normalized.formType || null,
    procedureIdentifier: override.procedureIdentifier || raw["procedure-identifier"] || normalized.procedureIdentifier || null,
    previousNoticeIds: unique(override.previousNoticeIds || raw["previous-notice-id-proc"] || normalized.previousNoticeIds || []),
    sourceStatus: normalized.sourceStatus || row.status || null,
    raw,
  };
}

function evidenceFor(row, fields, externalEvidence) {
  const supplied = externalEvidence.get(`${row.source_code}:${row.external_id}`);
  if (supplied) return (supplied.deadlines || []).map((item) => ({ ...item, sourcePayloadSha256: supplied.xmlSha256 || supplied.apiPageSha256 || item.sourcePayloadSha256 || null }));
  if (row.source_code === "TED") return tedSearchDeadlineEvidence(fields.raw, { sourceNoticeId: row.external_id, procedureIdentifier: fields.procedureIdentifier, sourceTimestamp: row.source_timestamp, sourceVersion: fields.raw["notice-version"] || row.source_timestamp });
  const normalized = row.normalized_data || {}, raw = normalized.raw || {}, lots = raw?.tender?.lots || normalized.lots || [], noticeDeadline = raw?.tender?.tenderPeriod?.endDate || normalized.offerDeadline || null;
  if (lots.length) return lots.map((lot) => parseAuthoritativeDeadline({ sourceDate: lot?.tenderPeriod?.endDate || noticeDeadline, lotKey: lot?.id || null, sourceNoticeId: row.external_id, procedureIdentifier: fields.procedureIdentifier, sourceTimestamp: row.source_timestamp, sourceVersion: row.source_timestamp, sourceKind: "DOE_OCDS" }));
  return noticeDeadline ? [parseAuthoritativeDeadline({ sourceDate: noticeDeadline, lotKey: "__NOTICE__", sourceNoticeId: row.external_id, procedureIdentifier: fields.procedureIdentifier, sourceTimestamp: row.source_timestamp, sourceVersion: row.source_timestamp, sourceKind: "DOE_OCDS" })] : [];
}

export function buildLifecyclePlan(rows, { asOf, relationEvidence = [], deadlineEvidence = [] } = {}) {
  const now = asOf instanceof Date ? asOf : new Date(asOf);
  if (Number.isNaN(now.getTime())) throw new Error("valid deterministic asOf is required");
  const relations = new Map(relationEvidence.map((item) => [`${item.sourceCode}:${item.externalId}`, item]));
  const deadlines = new Map(deadlineEvidence.map((item) => [`${item.sourceCode}:${item.externalId}`, item]));
  const planned = rows.map((row) => {
    const fields = noticeFields(row, relations);
    const notice = classifyNotice({ sourceCode: row.source_code, noticeType: fields.noticeType, noticeSubtype: fields.noticeSubtype, formType: fields.formType, tags: tags(fields.raw), sourceStatus: fields.sourceStatus });
    const sourceEnded = /(closed|complete|award|cancel|withdraw|terminated|unsuccessful|beendet|vergeben|aufgehoben|zurückgezogen)/i.test(String(fields.sourceStatus || ""));
    const deadlineRecords = evidenceFor(row, fields, deadlines).map((item) => ({ ...item, evidenceSha256: item.evidenceSha256 || sha256(canonicalJson(item)) }));
    const lotStates = assessLotDeadlines({ classification: notice.classification, evidence: deadlineRecords, sourceEnded, now });
    const aggregate = aggregateLotLifecycle(lotStates);
    return {
      id: row.id, source: row.source_code, externalId: row.external_id,
      fromLifecycle: row.source_lifecycle_status, fromParticipation: row.current_participation_status,
      fromClassification: row.current_notice_classification,
      fromDeadline: row.offer_deadline ? new Date(row.offer_deadline).toISOString() : null,
      toLifecycle: aggregate.sourceLifecycleStatus, toParticipation: aggregate.participationStatus,
      classification: notice.classification, reason: aggregate.participationBlockReason,
      deadlineTo: aggregate.offerDeadline, deadlineQuality: [...new Set(lotStates.map((lot) => lot.deadlineQuality))].sort().join("+"),
      noticeType: fields.noticeType, noticeSubtype: fields.noticeSubtype, formType: fields.formType,
      procedureIdentifier: fields.procedureIdentifier,
      relations: noticeRelationships({ sourceCode: row.source_code, externalId: row.external_id, procedureIdentifier: fields.procedureIdentifier, previousNoticeIds: fields.previousNoticeIds }),
      deadlineEvidence: deadlineRecords, lots: lotStates,
      sourceFingerprint: row.raw_sha256 || null,
    };
  });

  const byExternal = new Map(planned.map((row) => [`${row.source}:${row.externalId}`, row])), byProcedure = new Map();
  for (const row of planned) if (row.procedureIdentifier) {
    const key = `${row.source}:${row.procedureIdentifier}`, items = byProcedure.get(key) || [];
    items.push(row); byProcedure.set(key, items);
  }
  const terminal = new Set(["RESULT", "CONTRACT_MODIFICATION", "CANCELLATION"]);
  for (const closing of planned.filter((row) => terminal.has(row.classification))) {
    const candidates = new Set([...(closing.relations || []).map((relation) => byExternal.get(`${closing.source}:${relation.relatedExternalId}`)), ...(byProcedure.get(`${closing.source}:${closing.procedureIdentifier}`) || [])]);
    for (const original of candidates) if (original && original.id !== closing.id && ["COMPETITION", "CORRIGENDUM"].includes(original.classification)) {
      const lifecycle = closing.classification === "CANCELLATION" ? "WITHDRAWN" : "CLOSED";
      original.toLifecycle = lifecycle; original.toParticipation = "NOT_ELIGIBLE";
      original.reason = "NEWER_RELATED_NOTICE_CLOSED_PROCEDURE"; original.deadlineTo = null;
      original.lots = original.lots.map((lot) => ({ ...lot, lifecycleStatus: lifecycle, participationStatus: "NOT_ELIGIBLE", blockReason: original.reason }));
    }
  }
  planned.sort((a, b) => a.id.localeCompare(b.id));
  for (const row of planned) row.rowPlanSha256 = sha256(canonicalJson(row));
  const planDocument = { schema: "wb-lifecycle-plan/v2", asOf: now.toISOString(), rowCount: planned.length, rows: planned };
  const planSha256 = sha256(canonicalJson(planDocument));
  const inputProjection = rows.map((row) => ({ id: row.id, rawSha256: row.raw_sha256 || null, sourceTimestamp: row.source_timestamp ? new Date(row.source_timestamp).toISOString() : null })).sort((a, b) => a.id.localeCompare(b.id));
  const inputSha256 = sha256(canonicalJson({ rows: inputProjection, relationEvidence, deadlineEvidence }));
  return { planDocument, rows: planned, planSha256, inputSha256 };
}

export async function loadLifecycleRows(client) {
  return (await client.query(`SELECT t.id,t.source_code,t.external_id,t.publication_date,t.offer_deadline,t.source_timestamp,
      t.source_lifecycle_status,t.status,t.raw_sha256,to_jsonb(t)->>'notice_classification' current_notice_classification,
      to_jsonb(t)->>'participation_status' current_participation_status,tv.normalized_data
    FROM tender.tenders t LEFT JOIN LATERAL(
      SELECT normalized_data FROM tender.tender_versions version WHERE version.tender_id=t.id ORDER BY version.version DESC LIMIT 1
    ) tv ON true WHERE t.data_class='PUBLIC_REAL' ORDER BY t.id`)).rows;
}
