import crypto from "node:crypto";
import { XMLParser } from "fast-xml-parser";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(Z|[+-]\d{2}:?\d{2})?$/;
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/;
const OFFSET_RE = /^(?:Z|[+-]\d{2}:?\d{2})$/;
const BERLIN = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

const array = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const text = (value) => {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") return String(value).trim() || null;
  return text(value["#text"] ?? value._ ?? value.value);
};
const normalizeOffset = (value) => value === "Z" ? "Z" : value?.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2") || null;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const berlinValue = (instant) => {
  const parts = Object.fromEntries(BERLIN.formatToParts(instant).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}[Europe/Berlin]`;
};

function calendarValid(year, month, day) {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day;
}

export function parseAuthoritativeDeadline({
  sourceDate, sourceTime = null, deadlineType = "TENDER_RECEIPT", lotKey = null,
  sourceNoticeId = null, procedureIdentifier = null, sourceTimestamp = null,
  sourceVersion = null, sourceKind = "UNKNOWN",
} = {}) {
  const originalDate = text(sourceDate), originalTime = text(sourceTime);
  const base = { deadlineType, lotKey: text(lotKey), sourceNoticeId: text(sourceNoticeId), procedureIdentifier: text(procedureIdentifier), sourceTimestamp, sourceVersion: text(sourceVersion), sourceKind, sourceDate: originalDate, sourceTime: originalTime, sourceTimezone: null, normalizedUtc: null, europeBerlin: null, dateOnly: false, parsingStatus: "INVALID", decisionReason: "DEADLINE_DATE_INVALID" };
  if (!originalDate) return { ...base, parsingStatus: "MISSING", decisionReason: "DEADLINE_DATE_MISSING" };

  // ISO timestamps supplied by OCDS/API sources are accepted as one atomic
  // value only when they carry an explicit Z/offset.
  if (originalDate.includes("T")) {
    const match = originalDate.match(/(Z|[+-]\d{2}:?\d{2})$/);
    if (!match) return { ...base, decisionReason: "DEADLINE_TIMEZONE_MISSING" };
    const instant = new Date(originalDate);
    if (Number.isNaN(instant.getTime())) return base;
    return { ...base, sourceTimezone: normalizeOffset(match[1]), normalizedUtc: instant.toISOString(), europeBerlin: berlinValue(instant), parsingStatus: "EXACT", decisionReason: "AUTHORITATIVE_TIMESTAMP" };
  }

  const date = originalDate.match(DATE_RE);
  if (!date || !calendarValid(Number(date[1]), Number(date[2]), Number(date[3]))) return base;
  const dateOffset = normalizeOffset(date[4]);
  if (!originalTime) return { ...base, sourceTimezone: dateOffset, dateOnly: true, parsingStatus: "DATE_ONLY", decisionReason: "AUTHORITATIVE_TIME_MISSING" };
  const time = originalTime.match(TIME_RE);
  if (!time || Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3] || 0) > 59) return { ...base, sourceTimezone: dateOffset, decisionReason: "DEADLINE_TIME_INVALID" };
  const timeOffset = normalizeOffset(time[5]);
  if (dateOffset && timeOffset && dateOffset !== timeOffset) return { ...base, sourceTimezone: `${dateOffset}/${timeOffset}`, parsingStatus: "AMBIGUOUS", decisionReason: "DEADLINE_OFFSET_CONFLICT" };
  const offset = timeOffset || dateOffset;
  if (!offset || !OFFSET_RE.test(offset)) return { ...base, decisionReason: "DEADLINE_TIMEZONE_MISSING" };
  const fraction = time[4] ? `.${time[4]}` : "";
  const iso = `${date[1]}-${date[2]}-${date[3]}T${time[1]}:${time[2]}:${time[3] || "00"}${fraction}${offset}`;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return base;
  return { ...base, sourceTimezone: offset, normalizedUtc: instant.toISOString(), europeBerlin: berlinValue(instant), parsingStatus: "EXACT", decisionReason: "AUTHORITATIVE_DATE_TIME_OFFSET" };
}

function findAll(node, key, output = []) {
  if (!node || typeof node !== "object") return output;
  for (const [name, value] of Object.entries(node)) {
    if (name === key) output.push(...array(value));
    for (const child of array(value)) findAll(child, key, output);
  }
  return output;
}

export function parseTedEformsXmlDeadlines(xml, metadata = {}) {
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: true });
  let document;
  try { document = parser.parse(xml); } catch {
    return [{ ...parseAuthoritativeDeadline(metadata), parsingStatus: "INVALID", decisionReason: "TED_XML_INVALID" }];
  }
  const lots = findAll(document, "ProcurementProjectLot"), records = [];
  for (const lot of lots) {
    const lotKey = text(lot.ID);
    const periods = findAll(lot, "TenderSubmissionDeadlinePeriod");
    for (const period of periods) records.push(parseAuthoritativeDeadline({ ...metadata, lotKey, sourceDate: text(period.EndDate), sourceTime: text(period.EndTime), sourceKind: "TED_EFORMS_XML" }));
  }
  if (!records.length) return [{ ...parseAuthoritativeDeadline(metadata), parsingStatus: "MISSING", decisionReason: "TED_XML_TENDER_DEADLINE_MISSING", sourceKind: "TED_EFORMS_XML" }];
  return records;
}

export function tedSearchDeadlineEvidence(raw, metadata = {}) {
  const dates = array(raw?.["deadline-receipt-tender-date-lot"]).map(text).filter(Boolean);
  const times = array(raw?.["deadline-receipt-tender-time-lot"]).map(text).filter(Boolean);
  const lotKeys = array(raw?.["identifier-lot"]).map(text).filter(Boolean);
  if (!dates.length) return [];
  // Search result multi-value fields do not provide a documented positional
  // relationship. Only a single date/time/lot tuple is therefore bindable.
  if (dates.length === 1 && times.length === 1 && lotKeys.length === 1) {
    return [parseAuthoritativeDeadline({ ...metadata, sourceDate: dates[0], sourceTime: times[0], lotKey: lotKeys[0], sourceKind: "TED_SEARCH_API" })];
  }
  return dates.map((sourceDate, index) => {
    const parsed = parseAuthoritativeDeadline({ ...metadata, sourceDate, sourceTime: dates.length === 1 && times.length === 1 ? times[0] : null, sourceKind: "TED_SEARCH_API" });
    return { ...parsed, lotKey: null, parsingStatus: parsed.parsingStatus === "INVALID" ? "INVALID" : "UNBOUND", decisionReason: "TED_SEARCH_MULTIVALUE_LOT_BINDING_UNPROVEN", searchValueIndex: index };
  });
}

export function deadlineEvidenceFingerprint(records) {
  const projection = (records || []).map((record) => ({ ...record })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return sha256(JSON.stringify(projection));
}

export function assessLotDeadlines({ classification, evidence = [], sourceEnded = false, now = new Date() } = {}) {
  const terminal = new Set(["RESULT", "CONTRACT_MODIFICATION", "CANCELLATION", "VOLUNTARY_EX_ANTE"]);
  if (terminal.has(classification) || sourceEnded) return [{ lotKey: "__NOTICE__", lifecycleStatus: classification === "CANCELLATION" ? "WITHDRAWN" : "CLOSED", participationStatus: "NOT_ELIGIBLE", blockReason: terminal.has(classification) ? `NOTICE_${classification}` : "SOURCE_MARKED_PROCEDURE_ENDED", deadlineUtc: null, deadlineQuality: "NOT_APPLICABLE" }];
  if (!["COMPETITION", "CORRIGENDUM"].includes(classification)) return [{ lotKey: "__NOTICE__", lifecycleStatus: "REVIEW_REQUIRED", participationStatus: "REVIEW_REQUIRED", blockReason: classification === "PRIOR_INFORMATION" ? "PRIOR_INFORMATION_NOT_COMPETITION" : "NOTICE_CLASSIFICATION_INCOMPLETE", deadlineUtc: null, deadlineQuality: "NOT_APPLICABLE" }];
  if (!evidence.length) return [{ lotKey: "__UNASSIGNED__", lifecycleStatus: "REVIEW_REQUIRED", participationStatus: "REVIEW_REQUIRED", blockReason: "AUTHORITATIVE_LOT_DEADLINE_REQUIRED", deadlineUtc: null, deadlineQuality: "MISSING" }];

  const groups = new Map();
  for (const item of evidence) {
    const key = item.lotKey || "__UNASSIGNED__", items = groups.get(key) || [];
    items.push(item); groups.set(key, items);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([lotKey, items]) => {
    if (lotKey === "__UNASSIGNED__") {
      const berlinDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
      const sourceDays = items.map((item) => String(item.sourceDate || "").match(/^(\d{4}-\d{2}-\d{2})/)?.[1]).filter(Boolean);
      if (sourceDays.length === items.length && sourceDays.every((day) => day < berlinDay)) return { lotKey, lifecycleStatus: "EXPIRED", participationStatus: "NOT_ELIGIBLE", blockReason: "UNBOUND_DEADLINES_ALL_SAFELY_PAST", deadlineUtc: null, deadlineQuality: "DATE_ONLY_PAST_UNBOUND" };
      return { lotKey, lifecycleStatus: "REVIEW_REQUIRED", participationStatus: "REVIEW_REQUIRED", blockReason: "DEADLINE_LOT_BINDING_REQUIRED", deadlineUtc: null, deadlineQuality: "UNBOUND" };
    }
    if (items.some((item) => item.parsingStatus !== "EXACT")) return { lotKey, lifecycleStatus: "REVIEW_REQUIRED", participationStatus: "REVIEW_REQUIRED", blockReason: items.find((item) => item.parsingStatus !== "EXACT")?.decisionReason || "DEADLINE_EVIDENCE_INVALID", deadlineUtc: null, deadlineQuality: items.map((item) => item.parsingStatus).sort().join("+") };
    const instants = [...new Set(items.map((item) => item.normalizedUtc))];
    if (instants.length !== 1) return { lotKey, lifecycleStatus: "REVIEW_REQUIRED", participationStatus: "REVIEW_REQUIRED", blockReason: "CONFLICTING_DEADLINES_WITHIN_LOT", deadlineUtc: null, deadlineQuality: "CONFLICTING" };
    const deadline = new Date(instants[0]);
    return deadline <= now
      ? { lotKey, lifecycleStatus: "EXPIRED", participationStatus: "NOT_ELIGIBLE", blockReason: "LOT_DEADLINE_EXPIRED", deadlineUtc: deadline.toISOString(), deadlineQuality: "EXACT" }
      : { lotKey, lifecycleStatus: "ACTIVE", participationStatus: "ELIGIBLE", blockReason: null, deadlineUtc: deadline.toISOString(), deadlineQuality: "EXACT" };
  });
}

export function aggregateLotLifecycle(lots) {
  const active = lots.filter((lot) => lot.lifecycleStatus === "ACTIVE" && lot.participationStatus === "ELIGIBLE");
  const review = lots.filter((lot) => lot.lifecycleStatus === "REVIEW_REQUIRED");
  if (active.length) return { sourceLifecycleStatus: "ACTIVE", participationStatus: lots.length === active.length ? "ELIGIBLE" : "PARTIALLY_ELIGIBLE", participationBlockReason: lots.length === active.length ? null : "MIXED_LOT_LIFECYCLE", offerDeadline: active.map((lot) => lot.deadlineUtc).sort().at(-1) || null };
  if (review.length) return { sourceLifecycleStatus: "REVIEW_REQUIRED", participationStatus: "REVIEW_REQUIRED", participationBlockReason: review[0].blockReason, offerDeadline: null };
  if (lots.some((lot) => lot.lifecycleStatus === "WITHDRAWN")) return { sourceLifecycleStatus: "WITHDRAWN", participationStatus: "NOT_ELIGIBLE", participationBlockReason: lots[0].blockReason, offerDeadline: null };
  if (lots.some((lot) => lot.lifecycleStatus === "CLOSED")) return { sourceLifecycleStatus: "CLOSED", participationStatus: "NOT_ELIGIBLE", participationBlockReason: lots[0].blockReason, offerDeadline: null };
  return { sourceLifecycleStatus: "EXPIRED", participationStatus: "NOT_ELIGIBLE", participationBlockReason: "ALL_LOT_DEADLINES_EXPIRED", offerDeadline: lots.map((lot) => lot.deadlineUtc).filter(Boolean).sort().at(-1) || null };
}
