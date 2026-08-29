import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2] || "/app/platform/source-ingestion.mjs";
let source = readFileSync(target, "utf8");
const replaceOnce = (before, after, label) => {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) throw new Error(`DOE hotfix anchor mismatch: ${label}`);
  source = `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
};

replaceOnce('export const INGESTION_VERSION = "wb-public-source-ingestion/2.0.0";', 'export const INGESTION_VERSION = "wb-public-source-ingestion/2.1.0-doe-authoritative-terminal";', "version");

replaceOnce("\nexport async function fetchTedDay", `
export function assessDoeRequiredFields(raw) {
  const externalId = String(raw?.id || "").trim();
  const title = String(raw?.tender?.title || raw?.tender?.lots?.[0]?.title || "").trim();
  const buyer = String(raw?.buyer?.name || raw?.buyer?.identifier?.legalName || raw?.buyer?.identifier?.id || "").trim();
  const sourceUrl = String(raw?.uri || (externalId ? \`https://oeffentlichevergabe.de/api/notices/\${encodeURIComponent(externalId)}?format=ocds\` : "")).trim();
  return { importable: Boolean(externalId && title && buyer && sourceUrl), externalId: externalId || null,
    missingFields: [!externalId && "external_id", !title && "title", !buyer && "buyer", !sourceUrl && "source_url"].filter(Boolean) };
}

export function consolidateDoeReleases(input) {
  const keyed = new Map(), output = [];
  for (const record of input || []) {
    const externalId = String(record?.id || "").trim();
    if (!externalId) { output.push({ record, assessment: null }); continue; }
    if (!keyed.has(externalId)) keyed.set(externalId, []);
    keyed.get(externalId).push(record);
  }
  for (const [externalId, versions] of keyed) {
    if (versions.length === 1) { output.push({ record: versions[0], assessment: null }); continue; }
    const distinct = new Map(versions.map((record) => [sha256(json(record)), record]));
    if (distinct.size === 1) { output.push({ record: versions[0], assessment: null }); continue; }
    const dated = versions.map((record) => ({ record, instant: validDate(record?.date) ? Date.parse(record.date) : Number.NaN }))
      .filter((item) => Number.isFinite(item.instant)).sort((a, b) => b.instant - a.instant);
    if (dated.length && (dated.length === 1 || dated[0].instant > dated[1].instant)) {
      output.push({ record: dated[0].record, assessment: { status: "CONSOLIDATED_TO_LATEST_AUTHORITATIVE_RELEASE", sourceVersionCount: versions.length } });
    } else {
      output.push({ record: versions[0], assessment: { status: "AMBIGUOUS_SOURCE_VERSIONS", reason: "DOE_SOURCE_VERSION_AMBIGUOUS", sourceVersionCount: versions.length, externalId } });
    }
  }
  return { records: output.map((entry) => entry.record), assessments: output.map((entry) => entry.assessment), sourceRecordCount: (input || []).length };
}

export async function fetchTedDay`, "assessment");

const fetchStart = source.indexOf("export async function fetchDoeDay");
const fetchEnd = source.indexOf("\nexport function dueSource", fetchStart);
if (fetchStart < 0 || fetchEnd < 0) throw new Error("DOE hotfix anchor mismatch: fetchDoeDay");
source = `${source.slice(0, fetchStart)}${`export async function fetchDoeDay(day, { fetchImpl = fetch } = {}) {
  if (!dayPattern.test(day)) throw Object.assign(new Error("invalid DOE day"), { code: "INGESTION_DAY_INVALID" });
  const startedAt = new Date().toISOString();
  const url = \`https://oeffentlichevergabe.de/api/notice-exports?pubDay=\${day}&format=ocds.zip\`;
  const response = await fetchPublic(url, { headers: { accept: "application/zip" } }, { fetchImpl });
  if (!response.ok) throw Object.assign(new Error(\`DOE export failed (\${response.status})\`), { code: \`DOE_HTTP_\${response.status}\` });
  const bytes = Buffer.from(await response.arrayBuffer()), archive = await JSZip.loadAsync(bytes), sourceRecords = [];
  for (const entry of Object.values(archive.files)) {
    if (entry.dir || !entry.name.endsWith(".json")) continue;
    const payload = JSON.parse(await entry.async("string"));
    sourceRecords.push(...(payload.releases || []));
  }
  const consolidated = consolidateDoeReleases(sourceRecords), records = consolidated.records;
  const pages = [{ pageIndex: 0, sourceUrl: url, contentType: "application/zip", rawBytes: bytes, requestCursor: day, responseCursor: day }];
  const recordPageIndexes = records.map(() => 0), recordAssessments = consolidated.assessments;
  let retryCount = Number(response.wbRetryCount || 0), rateLimitCount = Number(response.wbRateLimitCount || 0);
  for (let index = 0; index < records.length; index += 1) {
    const feedAssessment = assessDoeRequiredFields(records[index]);
    if ((feedAssessment.importable && recordAssessments[index]?.status !== "AMBIGUOUS_SOURCE_VERSIONS") || !feedAssessment.externalId) continue;
    const detailUrl = \`https://oeffentlichevergabe.de/api/notices/\${encodeURIComponent(feedAssessment.externalId)}?format=ocds\`;
    try {
      const detailResponse = await fetchPublic(detailUrl, { headers: { accept: "application/json" } }, { fetchImpl });
      retryCount += Number(detailResponse.wbRetryCount || 0); rateLimitCount += Number(detailResponse.wbRateLimitCount || 0);
      if (!detailResponse.ok) continue;
      const detailBytes = Buffer.from(await detailResponse.arrayBuffer()), detailPayload = JSON.parse(detailBytes.toString("utf8"));
      const candidates = (Array.isArray(detailPayload?.releases) ? detailPayload.releases : Array.isArray(detailPayload) ? detailPayload : [detailPayload])
        .filter((candidate) => String(candidate?.id || "").trim() === feedAssessment.externalId);
      if (candidates.length !== 1) continue;
      const pageIndex = pages.length;
      pages.push({ pageIndex, sourceUrl: detailUrl, contentType: "application/json", rawBytes: detailBytes, requestCursor: feedAssessment.externalId, responseCursor: candidates[0]?.date || null });
      records[index] = candidates[0]; recordPageIndexes[index] = pageIndex;
      const detailAssessment = assessDoeRequiredFields(candidates[0]);
      recordAssessments[index] = detailAssessment.importable
        ? { status: "RESOLVED_FROM_AUTHORITATIVE_DETAIL", sourceUrl: detailUrl, sourcePayloadSha256: sha256(detailBytes) }
        : { status: "AUTHORITATIVE_NON_IMPORTABLE", reason: "DOE_AUTHORITATIVE_REQUIRED_FIELDS_MISSING", missingFields: detailAssessment.missingFields,
            sourceUrl: detailUrl, sourcePayloadSha256: sha256(detailBytes), observedAt: startedAt };
    } catch { /* unresolved evidence stays on the existing fail-closed quarantine path */ }
  }
  return { sourceCode: "DOE", day, pages, records, recordPageIndexes, recordAssessments, sourceRecordCount: consolidated.sourceRecordCount, cursorAfter: day, startedAt, retryCount, rateLimitCount };
}`}${source.slice(fetchEnd)}`;

replaceOnce("\nexport async function importFetchedDay", `
async function persistAuthoritativeNonImportable(client, context, raw, assessment, recordIndex, pageId) {
  if (context.sourceCode !== "DOE" || assessment?.status !== "AUTHORITATIVE_NON_IMPORTABLE") throw new Error("invalid terminal source assessment");
  const hash = sha256(json(raw)), externalId = String(raw?.id || "").trim() || null;
  const audit = [{ code: assessment.reason, missingFields: unique(assessment.missingFields).sort(), sourcePayloadSha256: assessment.sourcePayloadSha256,
    sourceUrl: assessment.sourceUrl, observedAt: assessment.observedAt }];
  const captured = await client.query(\`INSERT INTO tender.import_raw_payloads(import_run_id,scheduler_run_id,source_page_id,source_code,record_index,external_id,raw_text,raw_json,payload_sha256,retrieved_at,parser_version,mapper_version,processing_status,replay_status,normalization_audit,warnings)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,now(),$10,$10,'REJECTED','NOT_REQUIRED',$11::jsonb,$11::jsonb)
    ON CONFLICT(source_code,payload_sha256) DO UPDATE SET import_run_id=excluded.import_run_id,scheduler_run_id=excluded.scheduler_run_id,source_page_id=excluded.source_page_id,record_index=excluded.record_index,external_id=excluded.external_id,raw_text=excluded.raw_text,raw_json=excluded.raw_json,retrieved_at=excluded.retrieved_at,parser_version=excluded.parser_version,mapper_version=excluded.mapper_version,processing_status='REJECTED',replay_status='NOT_REQUIRED',normalization_audit=excluded.normalization_audit,warnings=excluded.warnings,updated_at=now() RETURNING id\`,
    [context.importRunId, context.schedulerRunId, pageId, context.sourceCode, recordIndex, externalId, json(raw), json(raw), hash, INGESTION_VERSION, json(audit)]);
  await client.query(\`INSERT INTO tender.import_quarantine(raw_payload_id,import_run_id,source_code,external_id,payload_sha256,error_code,error_class,error_field,safe_message,retry_status,manual_review_status,parser_version,mapper_version,resolved_at)
    VALUES($1,$2,$3,$4,$5,$6,'AUTHORITATIVE_SOURCE_VALIDATION',$7,$8,'NOT_REPAIRABLE','REJECTED',$9,$9,now())
    ON CONFLICT(raw_payload_id) DO UPDATE SET import_run_id=excluded.import_run_id,error_code=excluded.error_code,error_class=excluded.error_class,error_field=excluded.error_field,safe_message=excluded.safe_message,retry_status='NOT_REPAIRABLE',manual_review_status='REJECTED',parser_version=excluded.parser_version,mapper_version=excluded.mapper_version,resolved_at=coalesce(tender.import_quarantine.resolved_at,now()),updated_at=now()\`,
    [captured.rows[0].id, context.importRunId, context.sourceCode, externalId, hash, assessment.reason, unique(assessment.missingFields).sort().join(","), "authoritative public source lacks required import fields", INGESTION_VERSION]);
  return { kind: "rejected", tenderId: null, terminalSourceStatus: assessment.reason };
}

export async function importFetchedDay`, "terminal persistence");

replaceOnce(
  'const prior = (await client.query("SELECT id,raw_sha256,classification_status FROM tender.tenders WHERE source_code=$1 AND external_id=$2", [context.sourceCode, normalized.externalId])).rows[0];',
  `const prior = (await client.query("SELECT id,raw_sha256,classification_status,source_timestamp FROM tender.tenders WHERE source_code=$1 AND external_id=$2", [context.sourceCode, normalized.externalId])).rows[0];
  if (prior?.source_timestamp && normalized.sourceTimestamp && Date.parse(prior.source_timestamp) > Date.parse(normalized.sourceTimestamp)) {
    await client.query("UPDATE tender.tenders SET last_synced_at=now() WHERE id=$1", [prior.id]);
    await resolveQuarantine("DUPLICATE");
    return { kind: "duplicate", tenderId: prior.id, needsClassification: prior.classification_status !== "CLASSIFIED", reactivated: tombstoneDecision.reactivated, staleSourceVersion: true };
  }`,
  "monotone source version",
);

replaceOnce(
  "const result = await persistRecord(client, context, fetched.records[index], index, pageId);",
  `if (fetched.recordAssessments?.[index]?.status === "AMBIGUOUS_SOURCE_VERSIONS") throw Object.assign(new Error("authoritative DOE release version is ambiguous"), { code: "DOE_SOURCE_VERSION_AMBIGUOUS" });
        const result = fetched.recordAssessments?.[index]?.status === "AUTHORITATIVE_NON_IMPORTABLE"
          ? await persistAuthoritativeNonImportable(client, context, fetched.records[index], fetched.recordAssessments[index], index, pageId)
          : await persistRecord(client, context, fetched.records[index], index, pageId);`,
  "record dispatch",
);

writeFileSync(target, source);
