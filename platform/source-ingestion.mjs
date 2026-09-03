import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import pg from "pg";
import { reclassify } from "../scripts/reclassify-service-relevance.mjs";
import { runTenderCleanup, tombstoneImportDecision } from "./tender-cleanup.mjs";
import { runInboxPipeline } from "./inbox-pipeline.mjs";
import { classifyAndResolveNotice, noticeRelationships } from "./notice-lifecycle.mjs";
import { aggregateLotLifecycle, assessLotDeadlines, parseAuthoritativeDeadline, parseTedEformsXmlDeadlines, tedSearchDeadlineEvidence } from "./tender-deadlines.mjs";

export const INGESTION_VERSION = "wb-public-source-ingestion/2.1.0";
export const PUBLIC_SOURCES = Object.freeze(["DOE", "TED"]);
const TED_FIELDS = Object.freeze([
  "publication-number", "publication-date", "notice-title", "buyer-name",
  "classification-cpv", "place-of-performance", "notice-type",
  "notice-subtype", "form-type", "procedure-identifier", "previous-notice-id-proc",
  "identifier-lot", "deadline-receipt-tender-date-lot", "deadline-receipt-tender-time-lot", "links",
  "document-url-lot", "document-restricted-url-lot", "submission-url-lot", "buyer-profile",
]);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value ?? null);
const unique = (values) => [...new Set((values || []).flat().filter(Boolean).map(String))];
const localized = (value) => {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const preferred = value.deu ?? value.ger ?? value.eng ?? Object.values(value)[0];
  return (Array.isArray(preferred) ? preferred[0] : preferred || "").trim();
};
const validDate = (value) => value && !Number.isNaN(Date.parse(value)) ? value : null;
const earliestDate = (values) => unique(values).filter(validDate).sort((a, b) => Date.parse(a) - Date.parse(b))[0] || null;
const tedDateWithOffsetOnly = /^(\d{4}-\d{2}-\d{2})[+-]\d{2}:?\d{2}$/;
export function tedOfferDeadline(values) {
  const candidates = unique(values).map((value) => String(value).trim()).filter((value) => validDate(value) && !tedDateWithOffsetOnly.test(value));
  return candidates.length === 1 ? candidates[0] : null;
}
const nextDay = (day) => {
  const value = new Date(`${day}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
};
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const berlinFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const berlinParts = (date) => Object.fromEntries(berlinFormatter.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
export const berlinDay = (date = new Date()) => {
  const part = berlinParts(date);
  return `${part.year}-${part.month}-${part.day}`;
};
const addDays = (day, amount) => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
};
export function dailyWindow(now = new Date(), lookbackDays = 3) {
  const end = addDays(berlinDay(now), -1);
  return { from: addDays(end, -(Math.max(1, lookbackDays) - 1)), to: end };
}
export function nextBerlinRun(after = new Date()) {
  const cursor = new Date(after);
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  for (let offset = 0; offset < 27 * 60; offset += 1) {
    const candidate = new Date(cursor.getTime() + offset * 60_000), part = berlinParts(candidate);
    if (part.hour === "03" && part.minute === "15") return candidate;
  }
  throw new Error("next Europe/Berlin 03:15 schedule could not be resolved");
}
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const retryDelay = (response, attempt) => {
  const header = response.headers?.get?.("retry-after"), seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(60_000, seconds * 1_000);
  const date = header && Date.parse(header);
  if (date && date > Date.now()) return Math.min(60_000, date - Date.now());
  const exponential = Math.min(30_000, 1_000 * (2 ** attempt));
  return Math.round(exponential * (0.75 + Math.random() * 0.5));
};

export async function fetchPublic(url, options, { fetchImpl = fetch, attempts = 7 } = {}) {
  let response, lastError, rateLimitCount = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      response = await fetchImpl(url, { ...options, headers: { "user-agent": "WB-Tender-Public-Ingestion/2.0", ...options?.headers }, signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts) throw Object.assign(new Error("public source request failed after bounded retries"), { code: String(error.code || error.name || "SOURCE_NETWORK_ERROR"), wbRetryCount: attempt, wbRateLimitCount: rateLimitCount });
      await sleep(Math.min(30_000, 1_000 * (2 ** attempt)));
      continue;
    }
    if (response.status === 429) rateLimitCount += 1;
    response.wbRetryCount = attempt;
    response.wbRateLimitCount = rateLimitCount;
    if (response.status !== 429 && response.status < 500) return response;
    if (attempt + 1 < attempts) await sleep(retryDelay(response, attempt));
  }
  if (response) return response;
  throw lastError || new Error("public source request failed");
}

export function normalizeTedNotice(raw, retrievedAt = new Date().toISOString()) {
  const externalId = String(raw?.["publication-number"] || "").trim();
  const title = localized(raw?.["notice-title"]);
  const buyer = localized(raw?.["buyer-name"]);
  const sourceUrl = localized(raw?.links?.xml?.MUL) || localized(raw?.links?.html?.DEU) || localized(raw?.links?.html?.ENG) || "";
  if (!externalId || !title || !buyer || !sourceUrl) throw Object.assign(new Error("required public TED fields missing"), { code: "TED_REQUIRED_FIELD_MISSING" });
  const publicationDate = String(raw?.["publication-date"] || "").slice(0, 10) || null;
  const sourceStatus = localized(raw?.["notice-type"]);
  const noticeType = sourceStatus;
  const noticeSubtype = localized(raw?.["notice-subtype"]);
  const formType = localized(raw?.["form-type"]);
  const procedureIdentifier = localized(raw?.["procedure-identifier"]);
  const previousNoticeIds = unique(raw?.["previous-notice-id-proc"]);
  if (raw?.__wbDeadlineFetchError) throw Object.assign(new Error("authoritative TED XML deadline evidence unavailable"), { code: "TED_DEADLINE_EVIDENCE_UNAVAILABLE" });
  const classification = classifyAndResolveNotice({ sourceCode: "TED", noticeType, noticeSubtype, formType, sourceStatus, offerDeadline: null, now: new Date(retrievedAt) });
  const deadlineEvidence = Array.isArray(raw?.__wbDeadlineEvidence)
    ? raw.__wbDeadlineEvidence.map((item) => ({ ...item, sourcePayloadSha256: raw.__wbDeadlineXmlSha256 || null }))
    : tedSearchDeadlineEvidence(raw, { sourceNoticeId: externalId, procedureIdentifier, sourceTimestamp: retrievedAt, sourceVersion: raw?.["notice-version"] || raw?.["publication-date"] || null });
  const lotLifecycles = assessLotDeadlines({ classification: classification.classification, evidence: deadlineEvidence, sourceEnded: false, now: new Date(retrievedAt) });
  const lifecycle = aggregateLotLifecycle(lotLifecycles);
  const offerDeadline = lifecycle.offerDeadline;
  const normalized = {
    sourceCode: "TED", externalId, noticeNumber: externalId, tedId: externalId,
    buyer, title, description: "", cpvCodes: unique(raw?.["classification-cpv"]),
    regions: unique(raw?.["place-of-performance"]), publicationDate,
    offerDeadline, sourceUrl, sourceTimestamp: retrievedAt, sourceStatus,
    noticeClassification: classification.classification, participationStatus: lifecycle.participationStatus,
    participationBlockReason: lifecycle.participationBlockReason, sourceLifecycleStatus: lifecycle.sourceLifecycleStatus,
    noticeType, noticeSubtype, formType, procedureIdentifier, previousNoticeIds,
    noticeRelationships: noticeRelationships({ sourceCode: "TED", externalId, procedureIdentifier, previousNoticeIds }), raw,
    deadlineEvidence, lotLifecycles,
  };
  normalized.rawSha256 = sha256(json(raw));
  return normalized;
}

export function normalizeDoeRelease(raw) {
  const externalId = String(raw?.id || "").trim();
  const title = String(raw?.tender?.title || raw?.tender?.lots?.[0]?.title || "").trim();
  const buyer = String(raw?.buyer?.name || raw?.buyer?.identifier?.legalName || raw?.buyer?.identifier?.id || "").trim();
  const sourceUrl = String(raw?.uri || (externalId ? `https://oeffentlichevergabe.de/api/notices/${encodeURIComponent(externalId)}?format=ocds` : "")).trim();
  if (!externalId || !title || !buyer || !sourceUrl) throw Object.assign(new Error("required public DOE fields missing"), { code: "DOE_REQUIRED_FIELD_MISSING" });
  const items = raw?.tender?.items || [], lots = raw?.tender?.lots || [];
  const rawOfferDeadline = raw?.tender?.tenderPeriod?.endDate || null;
  const sourceStatus = String(raw?.tender?.status || unique(raw?.tag).join(","));
  const tags = unique(raw?.tag);
  const procedureIdentifier = String(raw?.ocid || raw?.tender?.id || "").trim() || null;
  const previousNoticeIds = unique((raw?.relatedProcesses || []).filter((item) => unique(item?.relationship).some((value) => /prior|parent|update|amend/i.test(value))).map((item) => item?.identifier || item?.id));
  const classification = classifyAndResolveNotice({ sourceCode: "DOE", tags, sourceStatus, offerDeadline: null, now: validDate(raw?.date) ? new Date(raw.date) : new Date() });
  const deadlineEvidence = lots.length
    ? lots.map((lot) => parseAuthoritativeDeadline({ sourceDate: lot?.tenderPeriod?.endDate || rawOfferDeadline, lotKey: lot?.id || null, sourceNoticeId: externalId, procedureIdentifier, sourceTimestamp: raw?.date || raw?.publishedDate || null, sourceVersion: raw?.date || null, sourceKind: "DOE_OCDS" }))
    : rawOfferDeadline ? [parseAuthoritativeDeadline({ sourceDate: rawOfferDeadline, lotKey: "__NOTICE__", sourceNoticeId: externalId, procedureIdentifier, sourceTimestamp: raw?.date || raw?.publishedDate || null, sourceVersion: raw?.date || null, sourceKind: "DOE_OCDS" })] : [];
  const lotLifecycles = assessLotDeadlines({ classification: classification.classification, evidence: deadlineEvidence, sourceEnded: /(closed|complete|award|cancel|withdraw|terminated|unsuccessful)/i.test(sourceStatus), now: validDate(raw?.date) ? new Date(raw.date) : new Date() });
  const lifecycle = aggregateLotLifecycle(lotLifecycles);
  const offerDeadline = lifecycle.offerDeadline;
  const deadlineStatus = offerDeadline
    ? "EXACT"
    : deadlineEvidence.some((item) => item.parsingStatus === "INVALID")
      ? "SOURCE_DEADLINE_INVALID"
      : deadlineEvidence.length
        ? "SOURCE_DEADLINE_UNBOUND"
        : "MISSING_AT_SOURCE";
  const normalized = {
    sourceCode: "DOE", externalId, noticeNumber: null, tedId: null, buyer, title,
    description: String(raw?.tender?.description || ""),
    cpvCodes: unique(items.flatMap((item) => [item?.classification?.id, ...(item?.additionalClassifications || []).map((entry) => entry?.id)])),
    regions: unique(items.map((item) => item?.deliveryAddress?.region)),
    locations: items.map((item) => item?.deliveryAddress).filter(Boolean).map((address) => ({ region: address.region || null, nuts: address.nuts || null, locality: address.locality || address.city || null, postalCode: address.postalCode || address.postal_code || null, country: address.countryName || address.country || null })),
    publicationDate: String(raw?.publishedDate || raw?.date || "").slice(0, 10) || null,
    offerDeadline,
    contractStart: earliestDate(lots.map((lot) => lot?.contractPeriod?.startDate)),
    contractEnd: earliestDate(lots.map((lot) => lot?.contractPeriod?.endDate)),
    sourceUrl, sourceTimestamp: validDate(raw?.date) ? raw.date : raw?.publishedDate || null,
    sourceStatus, noticeClassification: classification.classification, participationStatus: lifecycle.participationStatus,
    participationBlockReason: lifecycle.participationBlockReason, sourceLifecycleStatus: lifecycle.sourceLifecycleStatus,
    noticeType: tags.join(",") || null, noticeSubtype: null, formType: null, procedureIdentifier, previousNoticeIds,
    noticeRelationships: noticeRelationships({ sourceCode: "DOE", externalId, procedureIdentifier, previousNoticeIds }), raw, lots,
    deadlineEvidence, lotLifecycles, deadlineStatus,
  };
  normalized.rawSha256 = sha256(json(raw));
  return normalized;
}

export function assessDoeRequiredFields(raw) {
  const externalId = String(raw?.id || "").trim();
  const title = String(raw?.tender?.title || raw?.tender?.lots?.[0]?.title || "").trim();
  const buyer = String(raw?.buyer?.name || raw?.buyer?.identifier?.legalName || raw?.buyer?.identifier?.id || "").trim();
  const sourceUrl = String(raw?.uri || (externalId ? `https://oeffentlichevergabe.de/api/notices/${encodeURIComponent(externalId)}?format=ocds` : "")).trim();
  return {
    importable: Boolean(externalId && title && buyer && sourceUrl),
    externalId: externalId || null,
    missingFields: [!externalId && "external_id", !title && "title", !buyer && "buyer", !sourceUrl && "source_url"].filter(Boolean),
  };
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

export async function fetchTedDay(day, { fetchImpl = fetch, xmlEvidenceLookup = async () => new Map() } = {}) {
  if (!dayPattern.test(day)) throw Object.assign(new Error("invalid TED day"), { code: "INGESTION_DAY_INVALID" });
  const startedAt = new Date().toISOString();
  const url = "https://api.ted.europa.eu/v3/notices/search", pages = [], records = [], recordPageIndexes = [];
  let token = null, page = 0, retryCount = 0, rateLimitCount = 0;
  do {
    const body = {
      query: `publication-date = ${day.replaceAll("-", "")} AND place-of-performance IN (DE*)`,
      fields: TED_FIELDS, limit: 250, scope: "ALL", checkQuerySyntax: false,
      paginationMode: "ITERATION", ...(token ? { iterationNextToken: token } : {}),
    };
    const response = await fetchPublic(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) }, { fetchImpl });
    retryCount += Number(response.wbRetryCount || 0);
    rateLimitCount += Number(response.wbRateLimitCount || 0);
    if (!response.ok) throw Object.assign(new Error(`TED search failed (${response.status})`), { code: `TED_HTTP_${response.status}` });
    const bytes = Buffer.from(await response.arrayBuffer()), payload = JSON.parse(bytes.toString("utf8"));
    if (payload.timedOut) throw Object.assign(new Error("TED search timed out"), { code: "TED_TIMED_OUT" });
    pages.push({ pageIndex: page, sourceUrl: url, contentType: "application/json", rawBytes: bytes, requestCursor: token, responseCursor: payload.iterationNextToken || null });
    records.push(...(payload.notices || []));
    recordPageIndexes.push(...(payload.notices || []).map(() => page));
    token = payload.notices?.length ? payload.iterationNextToken || null : null;
    page += 1;
    if (page > 200) throw Object.assign(new Error("TED pagination safety limit reached"), { code: "TED_PAGE_LIMIT" });
  } while (token);
  const deadlineCandidates = records.filter((raw) => /^c(?:n|orr)/i.test(String(raw?.["notice-type"] || "")) && localized(raw?.links?.xml?.MUL) && unique(raw?.["deadline-receipt-tender-date-lot"]).length), xmlPages = new Array(deadlineCandidates.length);
  const cachedXml = await xmlEvidenceLookup(deadlineCandidates.map((raw) => String(raw["publication-number"] || "").trim()).filter(Boolean));
  let evidenceCursor = 0;
  await Promise.all(Array.from({ length: Math.min(2, Math.max(1, deadlineCandidates.length)) }, async () => {
    while (true) {
      const index = evidenceCursor++; if (index >= deadlineCandidates.length) return;
      const raw = deadlineCandidates[index], noticeId = String(raw["publication-number"] || "").trim(), xmlUrl = localized(raw.links.xml.MUL);
      try {
        const cached = cachedXml instanceof Map ? cachedXml.get(noticeId) : null;
        let bytes, responseCursor = raw["notice-version"] || null;
        if (cached?.rawBytes) {
          bytes = Buffer.from(cached.rawBytes);
          responseCursor = cached.responseCursor || responseCursor;
        } else {
          const response = await fetchPublic(xmlUrl, { headers: { accept: "application/xml,text/xml" } }, { fetchImpl, attempts: 7 });
          retryCount += Number(response.wbRetryCount || 0);
          rateLimitCount += Number(response.wbRateLimitCount || 0);
          if (!response.ok) throw Object.assign(new Error(`TED XML deadline fetch failed (${response.status})`), { code: `TED_XML_HTTP_${response.status}` });
          bytes = Buffer.from(await response.arrayBuffer());
        }
        const xml = bytes.toString("utf8");
        xmlPages[index] = { sourceUrl: xmlUrl, contentType: "application/xml", rawBytes: bytes, requestCursor: raw["publication-number"], responseCursor };
        Object.defineProperty(raw, "__wbDeadlineEvidence", { value: parseTedEformsXmlDeadlines(xml, { sourceNoticeId: raw["publication-number"], procedureIdentifier: localized(raw["procedure-identifier"]), sourceTimestamp: startedAt, sourceVersion: localized(raw["notice-version"]) || raw["publication-date"] || null, sourceKind: "TED_EFORMS_XML" }), enumerable: false });
        Object.defineProperty(raw, "__wbDeadlineXmlSha256", { value: sha256(xml), enumerable: false });
      } catch (error) { Object.defineProperty(raw, "__wbDeadlineFetchError", { value: String(error.code || "TED_DEADLINE_EVIDENCE_UNAVAILABLE"), enumerable: false }); }
    }
  }));
  for (const xmlPage of xmlPages.filter(Boolean)) pages.push({ ...xmlPage, pageIndex: page++ });
  return { sourceCode: "TED", day, pages, records, recordPageIndexes, cursorAfter: json({ day }), startedAt, retryCount, rateLimitCount };
}

export async function fetchDoeDay(day, { fetchImpl = fetch } = {}) {
  if (!dayPattern.test(day)) throw Object.assign(new Error("invalid DOE day"), { code: "INGESTION_DAY_INVALID" });
  const startedAt = new Date().toISOString();
  const url = `https://oeffentlichevergabe.de/api/notice-exports?pubDay=${day}&format=ocds.zip`;
  const response = await fetchPublic(url, { headers: { accept: "application/zip" } }, { fetchImpl });
  if (!response.ok) throw Object.assign(new Error(`DOE export failed (${response.status})`), { code: `DOE_HTTP_${response.status}` });
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
    const detailUrl = `https://oeffentlichevergabe.de/api/notices/${encodeURIComponent(feedAssessment.externalId)}?format=ocds`;
    try {
      const detailResponse = await fetchPublic(detailUrl, { headers: { accept: "application/json" } }, { fetchImpl });
      retryCount += Number(detailResponse.wbRetryCount || 0);
      rateLimitCount += Number(detailResponse.wbRateLimitCount || 0);
      if (!detailResponse.ok) continue;
      const detailBytes = Buffer.from(await detailResponse.arrayBuffer());
      const detailPayload = JSON.parse(detailBytes.toString("utf8"));
      const candidates = (Array.isArray(detailPayload?.releases) ? detailPayload.releases : Array.isArray(detailPayload) ? detailPayload : [detailPayload])
        .filter((candidate) => String(candidate?.id || "").trim() === feedAssessment.externalId);
      if (candidates.length !== 1) continue;
      const pageIndex = pages.length;
      pages.push({ pageIndex, sourceUrl: detailUrl, contentType: "application/json", rawBytes: detailBytes, requestCursor: feedAssessment.externalId, responseCursor: candidates[0]?.date || null });
      records[index] = candidates[0];
      recordPageIndexes[index] = pageIndex;
      const detailAssessment = assessDoeRequiredFields(candidates[0]);
      recordAssessments[index] = detailAssessment.importable ? {
        status: "RESOLVED_FROM_AUTHORITATIVE_DETAIL",
        sourceUrl: detailUrl,
        sourcePayloadSha256: sha256(detailBytes),
      } : {
        status: "AUTHORITATIVE_NON_IMPORTABLE",
        reason: "DOE_AUTHORITATIVE_REQUIRED_FIELDS_MISSING",
        missingFields: detailAssessment.missingFields,
        sourceUrl: detailUrl,
        sourcePayloadSha256: sha256(detailBytes),
        observedAt: startedAt,
      };
    } catch {
      // The unchanged export record is deliberately left to the normal quarantine
      // path when authoritative detail evidence cannot be obtained unambiguously.
    }
  }
  return { sourceCode: "DOE", day, pages, records, recordPageIndexes, recordAssessments, sourceRecordCount: consolidated.sourceRecordCount, cursorAfter: day, startedAt, retryCount, rateLimitCount };
}

export function dueSource(source, now = new Date()) {
  return Boolean(source?.enabled && !source?.kill_switch && (!source.next_run_at || new Date(source.next_run_at) <= now));
}

async function storePage(client, context, page) {
  const hash = sha256(page.rawBytes);
  const inserted = await client.query(`INSERT INTO tender.import_source_pages(import_run_id,scheduler_run_id,source_code,page_index,request_cursor,response_cursor,source_url,content_type,raw_bytes,payload_sha256,retrieved_at,parser_version,mapper_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$11) ON CONFLICT(source_code,payload_sha256) DO NOTHING RETURNING id`,
    [context.importRunId, context.schedulerRunId, context.sourceCode, page.pageIndex, page.requestCursor, page.responseCursor, page.sourceUrl, page.contentType, page.rawBytes, hash, INGESTION_VERSION]);
  if (inserted.rowCount) return inserted.rows[0].id;
  return (await client.query("SELECT id FROM tender.import_source_pages WHERE source_code=$1 AND payload_sha256=$2", [context.sourceCode, hash])).rows[0].id;
}

async function persistLifecycleMetadata(client, tenderId, normalized) {
  await client.query(`INSERT INTO tender.notice_lifecycle_transitions(tender_id,from_lifecycle,to_lifecycle,from_participation,to_participation,reason_code,evidence)
    SELECT id,source_lifecycle_status,$2,participation_status,$3,$4,$5::jsonb FROM tender.tenders
    WHERE id=$1 AND (source_lifecycle_status IS DISTINCT FROM $2 OR participation_status IS DISTINCT FROM $3)`,
    [tenderId,normalized.sourceLifecycleStatus,normalized.participationStatus,normalized.participationBlockReason,json({classification:normalized.noticeClassification,noticeType:normalized.noticeType,noticeSubtype:normalized.noticeSubtype,formType:normalized.formType,procedureIdentifier:normalized.procedureIdentifier,sourceSha256:normalized.rawSha256})]);
  await client.query(`UPDATE tender.tenders SET notice_classification=$2,participation_status=$3,participation_block_reason=$4,
    notice_type_code=$5,notice_subtype=$6,notice_form_type=$7,procedure_identifier=$8,source_lifecycle_status=$9,updated_at=now() WHERE id=$1`,
    [tenderId,normalized.noticeClassification,normalized.participationStatus,normalized.participationBlockReason,normalized.noticeType,normalized.noticeSubtype,normalized.formType,normalized.procedureIdentifier,normalized.sourceLifecycleStatus]);
  for (const relation of normalized.noticeRelationships || []) {
    const related = (await client.query("SELECT id FROM tender.tenders WHERE source_code=$1 AND external_id=$2",[relation.sourceCode,relation.relatedExternalId])).rows[0];
    await client.query(`INSERT INTO tender.tender_notice_relationships(source_tender_id,related_tender_id,source_code,source_external_id,related_external_id,procedure_identifier,relationship_type,evidence)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(source_tender_id,related_external_id,relationship_type) DO UPDATE SET related_tender_id=coalesce(tender.tender_notice_relationships.related_tender_id,excluded.related_tender_id),procedure_identifier=coalesce(excluded.procedure_identifier,tender.tender_notice_relationships.procedure_identifier),evidence=excluded.evidence,updated_at=now()`,
      [tenderId,related?.id||null,relation.sourceCode,relation.sourceExternalId,relation.relatedExternalId,relation.procedureIdentifier,relation.relationshipType,json({sourceSha256:normalized.rawSha256,noticeClassification:normalized.noticeClassification})]);
  }
  if (["RESULT","CONTRACT_MODIFICATION","CANCELLATION"].includes(normalized.noticeClassification)) {
    const previousIds=(normalized.noticeRelationships||[]).map((item)=>item.relatedExternalId);
    await client.query(`WITH affected AS(
      SELECT id,source_lifecycle_status,participation_status FROM tender.tenders
      WHERE id<>$1 AND source_code=$2 AND notice_classification IN('COMPETITION','CORRIGENDUM')
        AND (($3::text IS NOT NULL AND procedure_identifier=$3) OR external_id=ANY($4::text[]))
    ), history AS(
      INSERT INTO tender.notice_lifecycle_transitions(tender_id,from_lifecycle,to_lifecycle,from_participation,to_participation,reason_code,evidence)
      SELECT id,source_lifecycle_status,CASE WHEN $5='CANCELLATION' THEN 'WITHDRAWN' ELSE 'CLOSED' END,participation_status,'NOT_ELIGIBLE','NEWER_RELATED_NOTICE_CLOSED_PROCEDURE',$6::jsonb FROM affected
    ) UPDATE tender.tenders t SET source_lifecycle_status=CASE WHEN $5='CANCELLATION' THEN 'WITHDRAWN' ELSE 'CLOSED' END,participation_status='NOT_ELIGIBLE',participation_block_reason='NEWER_RELATED_NOTICE_CLOSED_PROCEDURE',updated_at=now() FROM affected WHERE t.id=affected.id`,
      [tenderId,normalized.sourceCode,normalized.procedureIdentifier,previousIds,normalized.noticeClassification,json({closingTenderId:tenderId,closingExternalId:normalized.externalId,sourceSha256:normalized.rawSha256})]);
  }
  await client.query("UPDATE tender.tender_deadline_evidence SET is_current=false,updated_at=now() WHERE tender_id=$1 AND is_current", [tenderId]);
  const evidenceIds = new Map();
  for (const item of normalized.deadlineEvidence || []) {
    const fingerprint = sha256(json(item));
    const saved = (await client.query(`INSERT INTO tender.tender_deadline_evidence(
        tender_id,source_code,source_notice_id,procedure_identifier,lot_key,deadline_type,source_date,source_time,
        source_timezone,normalized_utc,europe_berlin,source_timestamp,source_version,source_kind,parsing_status,
        decision_reason,date_only,evidence_sha256,raw_evidence,is_current)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,true)
      ON CONFLICT(tender_id,evidence_sha256) DO UPDATE SET is_current=true,updated_at=now() RETURNING id`, [
      tenderId, normalized.sourceCode, item.sourceNoticeId || normalized.externalId, item.procedureIdentifier || normalized.procedureIdentifier,
      item.lotKey, item.deadlineType || "TENDER_RECEIPT", item.sourceDate, item.sourceTime, item.sourceTimezone,
      item.normalizedUtc, item.europeBerlin, item.sourceTimestamp || normalized.sourceTimestamp, item.sourceVersion,
      item.sourceKind, item.parsingStatus, item.decisionReason, Boolean(item.dateOnly), fingerprint, json(item),
    ])).rows[0];
    if (item.lotKey && !evidenceIds.has(item.lotKey)) evidenceIds.set(item.lotKey, saved.id);
  }
  await client.query("UPDATE tender.tender_lot_lifecycles SET is_current=false,updated_at=now() WHERE tender_id=$1 AND is_current", [tenderId]);
  for (const lot of normalized.lotLifecycles || []) {
    await client.query(`INSERT INTO tender.tender_lot_lifecycles(tender_id,lot_key,lifecycle_status,participation_status,participation_block_reason,offer_deadline,deadline_quality,deadline_evidence_id,is_current)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,true)
      ON CONFLICT(tender_id,lot_key) DO UPDATE SET lifecycle_status=excluded.lifecycle_status,participation_status=excluded.participation_status,
        participation_block_reason=excluded.participation_block_reason,offer_deadline=excluded.offer_deadline,deadline_quality=excluded.deadline_quality,
        deadline_evidence_id=excluded.deadline_evidence_id,is_current=true,updated_at=now()`, [tenderId, lot.lotKey, lot.lifecycleStatus, lot.participationStatus, lot.blockReason, lot.deadlineUtc, lot.deadlineQuality, evidenceIds.get(lot.lotKey) || null]);
  }
}

export async function expireElapsedLifecycleDeadlines(pool, { now = new Date() } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='5min'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('wb-lifecycle-deadline-rollover'))");
    const expiredLots = (await client.query(`WITH targets AS MATERIALIZED(
        SELECT l.id,l.tender_id,l.lot_key,l.lifecycle_status,l.participation_status
        FROM tender.tender_lot_lifecycles l
        WHERE l.is_current AND l.lifecycle_status='ACTIVE' AND l.participation_status='ELIGIBLE'
          AND l.deadline_quality='EXACT' AND l.offer_deadline IS NOT NULL AND l.offer_deadline<=$1
        FOR UPDATE
      ), history AS(
        INSERT INTO tender.notice_lifecycle_transitions(
          tender_id,lot_key,from_lifecycle,to_lifecycle,from_participation,to_participation,reason_code,evidence
        ) SELECT tender_id,lot_key,lifecycle_status,'EXPIRED',participation_status,'NOT_ELIGIBLE',
          'LOT_DEADLINE_EXPIRED',jsonb_build_object('deadlineRolloverAt',$1::timestamptz,'externalWrite',false)
        FROM targets
      )
      UPDATE tender.tender_lot_lifecycles l
      SET lifecycle_status='EXPIRED',participation_status='NOT_ELIGIBLE',
          participation_block_reason='LOT_DEADLINE_EXPIRED',updated_at=now()
      FROM targets WHERE l.id=targets.id RETURNING l.tender_id`, [now])).rows;
    const tenderIds = [...new Set(expiredLots.map((row) => row.tender_id))];
    let tenderTransitions = 0;
    if (tenderIds.length) {
      const updated = await client.query(`WITH aggregate AS(
          SELECT t.id,t.source_lifecycle_status,t.participation_status,
            count(l.id)::int lot_count,
            count(l.id) FILTER(WHERE l.lifecycle_status='ACTIVE' AND l.participation_status='ELIGIBLE'
              AND l.deadline_quality='EXACT' AND l.offer_deadline>$2)::int active_count,
            count(l.id) FILTER(WHERE l.lifecycle_status='REVIEW_REQUIRED')::int review_count,
            count(l.id) FILTER(WHERE l.lifecycle_status='WITHDRAWN')::int withdrawn_count,
            count(l.id) FILTER(WHERE l.lifecycle_status='CLOSED')::int closed_count,
            max(l.offer_deadline) FILTER(WHERE l.lifecycle_status='ACTIVE' AND l.participation_status='ELIGIBLE'
              AND l.deadline_quality='EXACT' AND l.offer_deadline>$2) active_display_deadline,
            max(l.offer_deadline) display_deadline
          FROM tender.tenders t JOIN tender.tender_lot_lifecycles l ON l.tender_id=t.id AND l.is_current
          WHERE t.id=ANY($1::uuid[]) GROUP BY t.id
        ), target AS(
          SELECT *,
            CASE WHEN active_count>0 THEN 'ACTIVE' WHEN review_count>0 THEN 'REVIEW_REQUIRED'
              WHEN withdrawn_count>0 THEN 'WITHDRAWN' WHEN closed_count>0 THEN 'CLOSED' ELSE 'EXPIRED' END next_lifecycle,
            CASE WHEN active_count=lot_count THEN 'ELIGIBLE' WHEN active_count>0 THEN 'PARTIALLY_ELIGIBLE'
              WHEN review_count>0 THEN 'REVIEW_REQUIRED' ELSE 'NOT_ELIGIBLE' END next_participation
          FROM aggregate
        ), history AS(
          INSERT INTO tender.notice_lifecycle_transitions(
            tender_id,from_lifecycle,to_lifecycle,from_participation,to_participation,reason_code,evidence
          ) SELECT id,source_lifecycle_status,next_lifecycle,participation_status,next_participation,
            'LOT_DEADLINE_ROLLOVER',jsonb_build_object('deadlineRolloverAt',$2::timestamptz,'externalWrite',false)
          FROM target WHERE source_lifecycle_status IS DISTINCT FROM next_lifecycle
            OR participation_status IS DISTINCT FROM next_participation
          RETURNING tender_id
        )
        UPDATE tender.tenders t SET source_lifecycle_status=target.next_lifecycle,
          participation_status=target.next_participation,
          participation_block_reason=CASE WHEN target.active_count>0 AND target.active_count<target.lot_count THEN 'MIXED_LOT_LIFECYCLE'
            WHEN target.active_count=0 AND target.review_count>0 THEN 'LOT_REVIEW_REQUIRED'
            WHEN target.active_count=0 THEN 'ALL_LOT_DEADLINES_EXPIRED' ELSE NULL END,
          offer_deadline=coalesce(target.active_display_deadline,target.display_deadline),updated_at=now()
        FROM target WHERE t.id=target.id
        RETURNING (SELECT count(*)::int FROM history) transition_count`, [tenderIds, now]);
      tenderTransitions = Number(updated.rows[0]?.transition_count || 0);
    }
    await client.query("COMMIT");
    return { passed: true, expiredLots: expiredLots.length, affectedTenders: tenderIds.length, tenderTransitions };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function persistRecord(client, context, raw, recordIndex, pageId) {
  const normalized = context.sourceCode === "TED" ? normalizeTedNotice(raw, context.retrievedAt) : normalizeDoeRelease(raw);
  const tombstone = (await client.query("SELECT * FROM tender.tender_tombstones WHERE source_code=$1 AND external_id=$2", [context.sourceCode,normalized.externalId])).rows[0];
  const tombstoneDecision = tombstoneImportDecision(tombstone,normalized,new Date(context.retrievedAt));
  if (!tombstoneDecision.allow) return { kind:"tombstoned", tenderId:null, tombstoneReason:tombstoneDecision.reason };
  if (tombstoneDecision.reactivated) await client.query(`UPDATE tender.tender_tombstones SET tombstone_status='REACTIVATED',reactivated_at=now(),reactivation_reason=$3,reactivation_source_updated_at=$4,updated_at=now() WHERE source_code=$1 AND external_id=$2`, [context.sourceCode,normalized.externalId,tombstoneDecision.reason,normalized.sourceTimestamp]);
  const rawInsert = await client.query(`INSERT INTO tender.import_raw_payloads(import_run_id,scheduler_run_id,source_page_id,source_code,record_index,external_id,raw_text,raw_json,payload_sha256,retrieved_at,parser_version,mapper_version,processing_status,replay_status,normalization_audit,warnings)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,now(),$10,$10,'CAPTURED','IN_PROGRESS','[]'::jsonb,'[]'::jsonb)
    ON CONFLICT(source_code,payload_sha256) DO NOTHING RETURNING id`,
    [context.importRunId, context.schedulerRunId, pageId, context.sourceCode, recordIndex, normalized.externalId, json(raw), json(raw), normalized.rawSha256, INGESTION_VERSION]);
  const rawPayload = rawInsert.rows[0] || (await client.query("SELECT id,processing_status FROM tender.import_raw_payloads WHERE source_code=$1 AND payload_sha256=$2", [context.sourceCode, normalized.rawSha256])).rows[0];
  const resolveQuarantine = async (status) => {
    if (!rawPayload || (!rawInsert.rowCount && rawPayload.processing_status !== "QUARANTINED")) return;
    await client.query("UPDATE tender.import_raw_payloads SET processing_status=$2,replay_status='SUCCEEDED',updated_at=now() WHERE id=$1", [rawPayload.id, status]);
    await client.query("UPDATE tender.import_quarantine SET retry_status='SUCCEEDED',manual_review_status='RESOLVED',updated_at=now() WHERE raw_payload_id=$1 AND manual_review_status<>'RESOLVED'", [rawPayload.id]);
  };
  const prior = (await client.query("SELECT id,raw_sha256,classification_status,source_timestamp FROM tender.tenders WHERE source_code=$1 AND external_id=$2", [context.sourceCode, normalized.externalId])).rows[0];
  if (prior?.source_timestamp && normalized.sourceTimestamp && Date.parse(prior.source_timestamp) > Date.parse(normalized.sourceTimestamp)) {
    await client.query("UPDATE tender.tenders SET last_synced_at=now() WHERE id=$1", [prior.id]);
    await resolveQuarantine("DUPLICATE");
    return { kind: "duplicate", tenderId: prior.id, needsClassification: prior.classification_status !== "CLASSIFIED", reactivated: tombstoneDecision.reactivated, staleSourceVersion: true };
  }
  if (prior?.raw_sha256 === normalized.rawSha256) {
    await client.query(`UPDATE tender.tenders SET last_synced_at=now(),source_withdrawn_at=CASE WHEN $3='WITHDRAWN' THEN coalesce(source_withdrawn_at,now()) ELSE source_withdrawn_at END WHERE source_code=$1 AND external_id=$2`, [context.sourceCode, normalized.externalId, normalized.sourceLifecycleStatus]);
    await persistLifecycleMetadata(client,prior.id,normalized);
    await resolveQuarantine("DUPLICATE");
    return { kind: "duplicate", tenderId: prior.id, needsClassification: prior.classification_status !== "CLASSIFIED", reactivated: tombstoneDecision.reactivated };
  }
  const values = [context.sourceCode, normalized.externalId, normalized.noticeNumber, normalized.tedId, normalized.buyer, normalized.title, normalized.description, normalized.cpvCodes, normalized.regions, normalized.publicationDate, normalized.offerDeadline, normalized.contractStart || null, normalized.contractEnd || null, normalized.sourceUrl, normalized.sourceTimestamp, normalized.rawSha256, normalized.sourceLifecycleStatus];
  let tenderId, kind;
  if (!prior) {
    tenderId = (await client.query(`INSERT INTO tender.tenders(data_class,source_code,external_id,notice_number,ted_id,buyer,title,description,cpv_codes,regions,publication_date,offer_deadline,contract_start,contract_end,source_url,source_timestamp,raw_sha256,last_synced_at,source_lifecycle_status,source_withdrawn_at,classification_status)
      VALUES('PUBLIC_REAL',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now(),$17,CASE WHEN $17='WITHDRAWN' THEN now() END,'PENDING') RETURNING id`, values)).rows[0].id;
    kind = "new";
  } else {
    tenderId = prior.id;
    await client.query(`UPDATE tender.tenders SET notice_number=$3,ted_id=$4,buyer=$5,title=$6,description=$7,cpv_codes=$8,regions=$9,publication_date=$10,offer_deadline=$11,contract_start=$12,contract_end=$13,source_url=$14,source_timestamp=$15,raw_sha256=$16,last_synced_at=now(),source_lifecycle_status=$17,source_withdrawn_at=CASE WHEN $17='WITHDRAWN' THEN coalesce(source_withdrawn_at,now()) ELSE source_withdrawn_at END,classification_status='PENDING',updated_at=now() WHERE source_code=$1 AND external_id=$2`, values);
    kind = "updated";
  }
  await client.query("SELECT set_config('wb_tender.suppress_autopilot_enqueue','true',true)");
  const version = Number((await client.query("SELECT coalesce(max(version),0)+1 version FROM tender.tender_versions WHERE tender_id=$1", [tenderId])).rows[0].version);
  await client.query("INSERT INTO tender.tender_versions(tender_id,version,source_sha256,normalized_data,change_kind,source_timestamp) VALUES($1,$2,$3,$4::jsonb,$5,$6)", [tenderId, version, normalized.rawSha256, json(normalized), kind === "new" ? "INITIAL" : "UPDATED", normalized.sourceTimestamp]);
  await persistLifecycleMetadata(client,tenderId,normalized);
  await resolveQuarantine("IMPORTED");
  return { kind, tenderId, reactivated: tombstoneDecision.reactivated };
}

async function persistAuthoritativeNonImportable(client, context, raw, assessment, recordIndex, pageId) {
  if (context.sourceCode !== "DOE" || assessment?.status !== "AUTHORITATIVE_NON_IMPORTABLE") throw new Error("invalid terminal source assessment");
  const hash = sha256(json(raw));
  const externalId = String(raw?.id || "").trim() || null;
  const audit = [{
    code: assessment.reason,
    missingFields: unique(assessment.missingFields).sort(),
    sourcePayloadSha256: assessment.sourcePayloadSha256,
    sourceUrl: assessment.sourceUrl,
    observedAt: assessment.observedAt,
  }];
  const captured = await client.query(`INSERT INTO tender.import_raw_payloads(import_run_id,scheduler_run_id,source_page_id,source_code,record_index,external_id,raw_text,raw_json,payload_sha256,retrieved_at,parser_version,mapper_version,processing_status,replay_status,normalization_audit,warnings)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,now(),$10,$10,'REJECTED','NOT_REQUIRED',$11::jsonb,$11::jsonb)
    ON CONFLICT(source_code,payload_sha256) DO UPDATE SET import_run_id=excluded.import_run_id,scheduler_run_id=excluded.scheduler_run_id,source_page_id=excluded.source_page_id,record_index=excluded.record_index,external_id=excluded.external_id,raw_text=excluded.raw_text,raw_json=excluded.raw_json,retrieved_at=excluded.retrieved_at,parser_version=excluded.parser_version,mapper_version=excluded.mapper_version,processing_status='REJECTED',replay_status='NOT_REQUIRED',normalization_audit=excluded.normalization_audit,warnings=excluded.warnings,updated_at=now() RETURNING id`,
    [context.importRunId, context.schedulerRunId, pageId, context.sourceCode, recordIndex, externalId, json(raw), json(raw), hash, INGESTION_VERSION, json(audit)]);
  await client.query(`INSERT INTO tender.import_quarantine(raw_payload_id,import_run_id,source_code,external_id,payload_sha256,error_code,error_class,error_field,safe_message,retry_status,manual_review_status,parser_version,mapper_version,resolved_at)
    VALUES($1,$2,$3,$4,$5,$6,'AUTHORITATIVE_SOURCE_VALIDATION',$7,$8,'NOT_REPAIRABLE','REJECTED',$9,$9,now())
    ON CONFLICT(raw_payload_id) DO UPDATE SET import_run_id=excluded.import_run_id,error_code=excluded.error_code,error_class=excluded.error_class,error_field=excluded.error_field,safe_message=excluded.safe_message,retry_status='NOT_REPAIRABLE',manual_review_status='REJECTED',parser_version=excluded.parser_version,mapper_version=excluded.mapper_version,resolved_at=coalesce(tender.import_quarantine.resolved_at,now()),updated_at=now()`,
    [captured.rows[0].id, context.importRunId, context.sourceCode, externalId, hash, assessment.reason, unique(assessment.missingFields).sort().join(","), "authoritative public source lacks required import fields", INGESTION_VERSION]);
  return { kind: "rejected", tenderId: null, terminalSourceStatus: assessment.reason };
}

export async function importFetchedDay(pool, fetched, { triggerKind = "MANUAL" } = {}) {
  const client = await pool.connect(), ownerId = crypto.randomUUID(), started = fetched.startedAt || new Date().toISOString();
  let schedulerRunId, importRunId, committed = false, counts, classificationTenderIds = [], pipelineTenderIds = [];
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`wb-public-ingestion:${fetched.sourceCode}:${fetched.day}`]);
    schedulerRunId = (await client.query("INSERT INTO tender.scheduler_runs(source_code,trigger_kind,status,owner_id,started_at,cursor_before,metadata) SELECT $1,$2,'RUNNING',$3,$4,cursor_value,$5::jsonb FROM tender.scheduler_sources WHERE source_code=$1 RETURNING id", [fetched.sourceCode, triggerKind, ownerId, started, json({ day: fetched.day, pages: fetched.pages.length, parserVersion: INGESTION_VERSION, externalWrite: false })])).rows[0]?.id;
    if (!schedulerRunId) throw new Error("scheduler source missing");
    importRunId = (await client.query("INSERT INTO tender.import_runs(source_code,status,scheduler_run_id,started_at,cursor_before) SELECT $1,'RUNNING',$2,$3,cursor_value FROM tender.scheduler_sources WHERE source_code=$1 RETURNING id", [fetched.sourceCode, schedulerRunId, started])).rows[0].id;
    const context = { sourceCode: fetched.sourceCode, schedulerRunId, importRunId, retrievedAt: started }, pageIds = [];
    for (const page of fetched.pages) pageIds.push(await storePage(client, context, page));
    counts = { read: fetched.records.length, new: 0, updated: 0, duplicate: 0, rejected: 0, quarantined: 0, tombstoned: 0, reactivated: 0 };
    for (let index = 0; index < fetched.records.length; index += 1) {
      await client.query("SAVEPOINT import_record");
      try {
        const pageId = pageIds[fetched.recordPageIndexes?.[index] ?? 0] || pageIds[0];
        if (fetched.recordAssessments?.[index]?.status === "AMBIGUOUS_SOURCE_VERSIONS") throw Object.assign(new Error("authoritative DOE release version is ambiguous"), { code: "DOE_SOURCE_VERSION_AMBIGUOUS" });
        const result = fetched.recordAssessments?.[index]?.status === "AUTHORITATIVE_NON_IMPORTABLE"
          ? await persistAuthoritativeNonImportable(client, context, fetched.records[index], fetched.recordAssessments[index], index, pageId)
          : await persistRecord(client, context, fetched.records[index], index, pageId);
        counts[result.kind] += 1;
        if (result.reactivated) counts.reactivated += 1;
        if (result.tenderId) pipelineTenderIds.push(result.tenderId);
        if (result.tenderId && (result.kind !== "duplicate" || result.needsClassification)) classificationTenderIds.push(result.tenderId);
        await client.query("RELEASE SAVEPOINT import_record");
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT import_record");
        counts.quarantined += 1;
        const raw = fetched.records[index], hash = sha256(json(raw)), externalId = String(raw?.id || raw?.["publication-number"] || `record-${index}`);
        const pageId = pageIds[fetched.recordPageIndexes?.[index] ?? 0] || pageIds[0];
        const captured = await client.query(`INSERT INTO tender.import_raw_payloads(import_run_id,scheduler_run_id,source_page_id,source_code,record_index,external_id,raw_text,raw_json,payload_sha256,retrieved_at,parser_version,mapper_version,processing_status,replay_status,normalization_audit,warnings)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,now(),$10,$10,'QUARANTINED','QUARANTINED','[]'::jsonb,$11::jsonb)
          ON CONFLICT(source_code,payload_sha256) DO UPDATE SET import_run_id=excluded.import_run_id,scheduler_run_id=excluded.scheduler_run_id,source_page_id=excluded.source_page_id,record_index=excluded.record_index,external_id=excluded.external_id,raw_text=excluded.raw_text,raw_json=excluded.raw_json,retrieved_at=excluded.retrieved_at,parser_version=excluded.parser_version,mapper_version=excluded.mapper_version,processing_status='QUARANTINED',replay_status='QUARANTINED',warnings=excluded.warnings,updated_at=now() RETURNING id`,
          [importRunId, schedulerRunId, pageId, fetched.sourceCode, index, externalId, json(raw), json(raw), hash, INGESTION_VERSION, json([{ code: String(error.code || "NORMALIZATION_FAILED"), message: String(error.message).slice(0, 180) }])]);
        await client.query(`INSERT INTO tender.import_quarantine(raw_payload_id,import_run_id,source_code,external_id,payload_sha256,error_code,error_class,safe_message,retry_status,manual_review_status,parser_version,mapper_version)
          VALUES($1,$2,$3,$4,$5,$6,'NORMALIZATION',$7,'PENDING','OPEN',$8,$8)
          ON CONFLICT(raw_payload_id) DO UPDATE SET import_run_id=excluded.import_run_id,error_code=excluded.error_code,error_class=excluded.error_class,safe_message=excluded.safe_message,retry_status='PENDING',manual_review_status='OPEN',parser_version=excluded.parser_version,mapper_version=excluded.mapper_version,updated_at=now()`,
          [captured.rows[0].id, importRunId, fetched.sourceCode, externalId, hash, String(error.code || "NORMALIZATION_FAILED").slice(0, 80), String(error.message).slice(0, 180), INGESTION_VERSION]);
        await client.query("RELEASE SAVEPOINT import_record");
      }
    }
    await client.query("COMMIT");
    committed = true;
    classificationTenderIds = unique(classificationTenderIds);
    pipelineTenderIds = unique(pipelineTenderIds);
    const relevance = classificationTenderIds.length ? await reclassify(pool, { dryRun: false, tenderIds: classificationTenderIds, suppressPipelineEnqueue: true }) : { tenders: 0, inserted: 0 };
    const lifecycleRollover = await expireElapsedLifecycleDeadlines(pool, { now: new Date() });
    const inboxPipeline = pipelineTenderIds.length ? await runInboxPipeline(pool, { tenderIds: pipelineTenderIds, sourceRunId: schedulerRunId, runKind: triggerKind === "SCHEDULED" ? "SCHEDULED" : "MANUAL", batchSize: Number(process.env.INBOX_PIPELINE_BATCH_SIZE || 100) }) : { passed: true, checked: 0, matched: 0, inboxCreated: 0, regionCreated: 0, skipped: 0 };
    const downstreamFailed = !inboxPipeline.passed, errorCount = counts.quarantined + (downstreamFailed ? 1 : 0), status = errorCount ? "PARTIAL_FAILURE" : "SUCCESS", nextRun = nextBerlinRun();
    await pool.query("UPDATE tender.import_runs SET status=$2,outcome_status=$2,finished_at=now(),read_count=$3,new_count=$4,updated_count=$5,duplicate_count=$6,rejected_count=$7,error_count=$8,quarantined_count=$9,cursor_after=$10,tombstone_skipped_count=$11,reactivated_count=$12 WHERE id=$1", [importRunId, status, counts.read, counts.new, counts.updated, counts.duplicate, counts.rejected, errorCount, counts.quarantined, fetched.cursorAfter,counts.tombstoned,counts.reactivated]);
    await pool.query("UPDATE tender.scheduler_runs SET status=$2,outcome_status=$2,finished_at=now(),read_count=$3,new_count=$4,updated_count=$5,duplicate_count=$6,rejected_count=$7,error_count=$8,quarantined_count=$9,cursor_after=$10,next_run_at=$11,retry_count=$12,rate_limit_count=$13,error_code=$14,tombstone_skipped_count=$15,reactivated_count=$16 WHERE id=$1", [schedulerRunId, status, counts.read, counts.new, counts.updated, counts.duplicate, counts.rejected, errorCount, counts.quarantined, fetched.cursorAfter, nextRun, Number(fetched.retryCount || 0), Number(fetched.rateLimitCount || 0), counts.quarantined ? "RECORDS_QUARANTINED" : downstreamFailed ? "INBOX_PIPELINE_PARTIAL_FAILURE" : null,counts.tombstoned,counts.reactivated]);
    if (status !== "SUCCESS") await pool.query("UPDATE tender.scheduler_sources SET last_failure_at=now(),retry_count=retry_count+1,next_run_at=$2,updated_at=now() WHERE source_code=$1", [fetched.sourceCode, nextRun]);
    else await pool.query("UPDATE tender.scheduler_sources SET last_success_at=now(),last_failure_at=NULL,retry_count=0,cursor_value=$2,next_run_at=$3,updated_at=now() WHERE source_code=$1", [fetched.sourceCode, fetched.cursorAfter, nextRun]);
    return { passed: status === "SUCCESS", sourceCode: fetched.sourceCode, day: fetched.day, schedulerRunId, importRunId, counts, relevance, lifecycleRollover, inboxPipeline, nextRunAt: nextRun.toISOString(), externalWrite: false };
  } catch (error) {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    else if (schedulerRunId && importRunId) {
      const code = String(error.code || "CLASSIFICATION_FAILED").slice(0, 80), nextRun = nextBerlinRun();
      await pool.query("UPDATE tender.import_runs SET status='FAILED',outcome_status='FAILED',finished_at=now(),error_count=1 WHERE id=$1", [importRunId]).catch(() => {});
      await pool.query("UPDATE tender.scheduler_runs SET status='FAILED',outcome_status='FAILED',finished_at=now(),error_count=1,error_code=$2,next_run_at=$3 WHERE id=$1", [schedulerRunId, code, nextRun]).catch(() => {});
      await pool.query("UPDATE tender.scheduler_sources SET last_failure_at=now(),retry_count=retry_count+1,next_run_at=$2,updated_at=now() WHERE source_code=$1", [fetched.sourceCode, nextRun]).catch(() => {});
      error.ingestionFailureRecorded = true;
    }
    throw error;
  } finally { client.release(); }
}

async function recordSourceFailure(pool, sourceCode, error) {
  const code = String(error.code || "SOURCE_FETCH_FAILED").slice(0, 80), ownerId = crypto.randomUUID(), nextRun = nextBerlinRun();
  await pool.query(`WITH source AS(UPDATE tender.scheduler_sources SET last_failure_at=now(),retry_count=retry_count+1,next_run_at=$5,updated_at=now() WHERE source_code=$1 RETURNING *)
    INSERT INTO tender.scheduler_runs(source_code,trigger_kind,status,owner_id,started_at,finished_at,error_count,error_code,next_run_at,outcome_status,metadata)
    SELECT source_code,'SCHEDULED','FAILED',$2,now(),now(),1,$3,next_run_at,'FAILED',$4::jsonb FROM source`,
  [sourceCode, ownerId, code, json({ safeMessage: String(error.message || "source fetch failed").slice(0, 180), externalWrite: false }), nextRun]);
}

export async function acquireLease(pool, sourceCode, ownerId) {
  const result = await pool.query(`INSERT INTO tender.scheduler_leases(source_code,owner_id,acquired_at,renewed_at,expires_at)
    VALUES($1,$2,now(),now(),now()+interval '2 hours')
    ON CONFLICT(source_code) DO UPDATE SET owner_id=excluded.owner_id,acquired_at=excluded.acquired_at,renewed_at=excluded.renewed_at,expires_at=excluded.expires_at
    WHERE tender.scheduler_leases.owner_id=excluded.owner_id OR tender.scheduler_leases.expires_at<now() RETURNING source_code`, [sourceCode, ownerId]);
  return result.rowCount === 1;
}

async function renewLease(pool, sourceCode, ownerId) {
  await pool.query("UPDATE tender.scheduler_leases SET renewed_at=now(),expires_at=now()+interval '2 hours' WHERE source_code=$1 AND owner_id=$2", [sourceCode, ownerId]);
}

export async function runIngestion({ once = false } = {}) {
  if (String(process.env.EXTERNAL_SUBMISSION_ENABLED).toLowerCase() !== "false" || String(process.env.WB_TENDER_ALLOW_EXTERNAL_SUBMISSION).toLowerCase() !== "false") throw new Error("external submission must remain hard-disabled");
  const connectionString = process.env.DATABASE_URL || readFileSync(process.env.DATABASE_URL_FILE, "utf8").toString().trim();
  const pool = new pg.Pool({ connectionString, max: 4, options: "-c tender.pipeline_job_id=DAILY_INBOX_PIPELINE" });
  const workerId = crypto.randomUUID();
  const sources = String(process.env.INGESTION_SOURCES || "TED,DOE").split(",").map((value) => value.trim().toUpperCase()).filter((value) => PUBLIC_SOURCES.includes(value));
  if (!sources.length) throw new Error("no supported ingestion source configured");
  const explicitFrom = process.env.INGESTION_FROM, explicitTo = process.env.INGESTION_TO || explicitFrom;
  if ((explicitFrom && !dayPattern.test(explicitFrom)) || (explicitTo && !dayPattern.test(explicitTo)) || (explicitFrom && explicitTo < explicitFrom)) throw new Error("invalid ingestion date range");
  const failures = [], completed = [];
  try {
    do {
      const configured = (await pool.query("SELECT * FROM tender.scheduler_sources WHERE source_code=ANY($1::text[]) ORDER BY source_code", [sources])).rows;
      for (const source of configured) {
        if (!explicitFrom && !dueSource(source)) continue;
        if (!await acquireLease(pool, source.source_code, workerId)) {
          if (once) throw new Error(`active scheduler lease exists for ${source.source_code}`);
          continue;
        }
        const window = explicitFrom ? { from: explicitFrom, to: explicitTo } : dailyWindow(new Date(), Number(process.env.INGESTION_LOOKBACK_DAYS || 3));
        const { from, to } = window;
        for (let day = from; day <= to; day = nextDay(day)) {
          try {
            const fetched = source.source_code === "TED" ? await fetchTedDay(day, { xmlEvidenceLookup: async (noticeIds) => {
              if (!noticeIds.length) return new Map();
              const rows = (await pool.query(`SELECT DISTINCT ON(request_cursor) request_cursor,raw_bytes,response_cursor
                FROM tender.import_source_pages WHERE source_code='TED' AND content_type IN('application/xml','text/xml')
                  AND request_cursor=ANY($1::text[]) ORDER BY request_cursor,retrieved_at DESC`, [noticeIds])).rows;
              return new Map(rows.map((row) => [row.request_cursor, { rawBytes: row.raw_bytes, responseCursor: row.response_cursor }]));
            } }) : await fetchDoeDay(day);
            const result = await importFetchedDay(pool, fetched, { triggerKind: explicitFrom ? "MANUAL" : "SCHEDULED" });
            console.log(json(result));
            completed.push(result);
            if (!result.passed) failures.push({ sourceCode: source.source_code, day, errorCode: "PARTIAL_FAILURE" });
            await renewLease(pool, source.source_code, workerId);
          } catch (error) {
            if (!error.ingestionFailureRecorded) await recordSourceFailure(pool, source.source_code, error);
            console.error(json({ sourceCode: source.source_code, day, errorCode: String(error.code || "SOURCE_FETCH_FAILED"), safeMessage: String(error.message).slice(0, 180), externalWrite: false }));
            failures.push({ sourceCode: source.source_code, day, errorCode: String(error.code || "SOURCE_FETCH_FAILED") });
            if (!once) break;
          }
          if (failures.length && !once) {
            break;
          }
        }
      }
      if (once) {
        if (!explicitFrom && process.env.TENDER_CLEANUP_ENABLED !== "false") {
          const synchronizedSources = new Set(completed.filter((item) => item.passed).map((item) => item.sourceCode));
          const cleanup = await runTenderCleanup(pool,{syncSucceeded:failures.length===0 && sources.every((source) => synchronizedSources.has(source)),syncRunIds:completed.map((item) => item.schedulerRunId),batchSize:Number(process.env.TENDER_CLEANUP_BATCH_SIZE || 100),runKind:"SCHEDULED"});
          console.log(json({cleanup}));
          if (!cleanup.passed) failures.push({sourceCode:"CLEANUP",errorCode:cleanup.reason || "CLEANUP_FAILED"});
        }
        if (failures.length) throw Object.assign(new Error("one or more ingestion days failed"), { code: "INGESTION_RUN_FAILED", failures });
        break;
      }
      await pool.query("UPDATE tender.scheduler_leases SET renewed_at=now(),expires_at=now()+interval '2 hours' WHERE owner_id=$1", [workerId]);
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    } while (true);
  } finally {
    await pool.query("DELETE FROM tender.scheduler_leases WHERE owner_id=$1", [workerId]).catch(() => {});
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await runIngestion({ once: process.env.INGESTION_ONCE === "true" });
