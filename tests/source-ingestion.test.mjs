import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { berlinDay, dailyWindow, dueSource, fetchPublic, fetchTedDay, nextBerlinRun, normalizeDoeRelease, normalizeTedNotice } from "../platform/source-ingestion.mjs";

const ingestionSource = readFileSync(new URL("../platform/source-ingestion.mjs", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../platform/server.mjs", import.meta.url), "utf8");

test("TED normalizer preserves public source identity and German matching fields", () => {
  const row = normalizeTedNotice({
    "publication-number": "123456-2026", "publication-date": "2026-08-17+02:00",
    "notice-title": { deu: "Wartung von Zutrittskontrollanlagen" },
    "buyer-name": { deu: ["Stadt Beispiel"] }, "classification-cpv": ["50610000", "50610000"],
    "place-of-performance": ["DE2", "DE2"], "notice-type":"cn-standard", "identifier-lot":["LOT-0000"],
    "deadline-receipt-tender-date-lot": ["2026-09-15"], "deadline-receipt-tender-time-lot":["10:00:00+02:00"],
    links: { xml: { MUL: "https://ted.europa.eu/en/notice/123456-2026/xml" } },
  }, "2026-08-17T12:00:00Z");
  assert.deepEqual({ id: row.externalId, buyer: row.buyer, cpv: row.cpvCodes, regions: row.regions, deadline: row.offerDeadline }, { id: "123456-2026", buyer: "Stadt Beispiel", cpv: ["50610000"], regions: ["DE2"], deadline: "2026-09-15T08:00:00.000Z" });
});

test("TED normalizer keeps a notice active through its latest authoritatively bound lot deadline", () => {
  const row = normalizeTedNotice({
    "publication-number": "lot-deadlines", "notice-title": { deu: "Test" },
    "buyer-name": { deu: "Buyer" }, "notice-type":"cn-standard",
    __wbDeadlineEvidence:[
      {lotKey:"LOT-1",parsingStatus:"EXACT",normalizedUtc:"2026-01-15T09:00:00.000Z"},
      {lotKey:"LOT-2",parsingStatus:"EXACT",normalizedUtc:"2026-02-15T09:00:00.000Z"},
    ],
    links: { html: { DEU: "https://example.invalid" } },
  }, "2026-01-01T00:00:00Z");
  assert.equal(row.offerDeadline, "2026-02-15T09:00:00.000Z");
});

test("DOE normalizer uses only supplied production notice evidence", () => {
  const row = normalizeDoeRelease({ id: "notice-1", uri: "https://oeffentlichevergabe.de/api/notices/notice-1?format=ocds", date: "2026-08-17T08:00:00Z", buyer: { name: "Landkreis Beispiel" }, tender: { title: "Hausmeister- und Winterdienst", description: "Facility Management", tenderPeriod: { endDate: "2026-09-20T10:00:00Z" }, items: [{ classification: { id: "90620000" }, deliveryAddress: { region: "DE2" } }], lots: [] } });
  assert.equal(row.title, "Hausmeister- und Winterdienst");
  assert.deepEqual(row.cpvCodes, ["90620000"]);
  assert.deepEqual(row.regions, ["DE2"]);
  assert.equal(row.deadlineStatus, "SOURCE_DEADLINE_UNBOUND");
});

test("DOE deadlines distinguish missing source evidence from malformed evidence", () => {
  const base = { id: "doe-deadline", date: "2026-08-17T08:00:00Z", buyer: { name: "Landkreis" }, tender: { title: "Leistung", items: [], lots: [] } };
  assert.equal(normalizeDoeRelease(base).deadlineStatus, "MISSING_AT_SOURCE");
  assert.equal(normalizeDoeRelease({ ...base, tender: { ...base.tender, tenderPeriod: { endDate: "not-a-date" } } }).deadlineStatus, "SOURCE_DEADLINE_INVALID");
});

test("DOE normalizer derives only the documented public notice endpoint when exports omit uri", () => {
  const row = normalizeDoeRelease({ id: "d4d4c81d-6b1d-4908-8693-1d8df51baf1d", date: "2026-08-15T22:06:05Z", buyer: { name: "Stadt Beispiel" }, tender: { title: "Öffentlicher Auftrag", items: [], lots: [] } });
  assert.equal(row.sourceUrl, "https://oeffentlichevergabe.de/api/notices/d4d4c81d-6b1d-4908-8693-1d8df51baf1d?format=ocds");
  assert.equal(row.publicationDate, "2026-08-15");
});

test("public fetch retries a rate limit without changing the request", async () => {
  const calls = [];
  const response = await fetchPublic("https://example.invalid/public", { method: "POST", body: "{}" }, { attempts: 2, fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method, body: options.body });
    return { status: calls.length === 1 ? 429 : 200, headers: { get: () => "0" } };
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ url: "https://example.invalid/public", method: "POST", body: "{}" }, { url: "https://example.invalid/public", method: "POST", body: "{}" }]);
});

test("scheduler requires source enablement, released kill switch, and due time", () => {
  const now = new Date("2026-08-17T12:00:00Z");
  assert.equal(dueSource({ enabled: true, kill_switch: false, next_run_at: "2026-08-17T11:00:00Z" }, now), true);
  assert.equal(dueSource({ enabled: false, kill_switch: false, next_run_at: null }, now), false);
  assert.equal(dueSource({ enabled: true, kill_switch: true, next_run_at: null }, now), false);
  assert.equal(dueSource({ enabled: true, kill_switch: false, next_run_at: "2026-08-17T13:00:00Z" }, now), false);
});

test("daily window is recomputed in Europe/Berlin and overlaps three complete days", () => {
  assert.deepEqual(dailyWindow(new Date("2026-08-18T01:14:00Z")), { from: "2026-08-15", to: "2026-08-17" });
  assert.equal(berlinDay(new Date("2026-03-29T01:30:00Z")), "2026-03-29");
  assert.equal(nextBerlinRun(new Date("2026-03-28T23:00:00Z")).toISOString(), "2026-03-29T01:15:00.000Z");
  assert.equal(nextBerlinRun(new Date("2026-10-24T23:00:00Z")).toISOString(), "2026-10-25T02:15:00.000Z");
});

test("TED iteration follows every pagination token and terminates", async () => {
  const requests = [];
  const pages = [
    { notices: [{ "publication-number": "1-2026", "publication-date": "2026-08-18", "notice-title": { deu: "Reinigung" }, "buyer-name": { deu: ["Stadt"] }, links: { html: { DEU: "https://ted.europa.eu/1" } } }], iterationNextToken: "next" },
    { notices: [{ "publication-number": "2-2026", "publication-date": "2026-08-18", "notice-title": { deu: "Bewachung" }, "buyer-name": { deu: ["Land"] }, links: { html: { DEU: "https://ted.europa.eu/2" } } }] },
  ];
  const fetched = await fetchTedDay("2026-08-18", { fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const payload = pages.shift();
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => Buffer.from(JSON.stringify(payload)) };
  } });
  assert.equal(fetched.pages.length, 2);
  assert.equal(fetched.records.length, 2);
  assert.equal(requests[0].iterationNextToken, undefined);
  assert.equal(requests[1].iterationNextToken, "next");
});

test("network timeout is bounded and returned as a safe failure", async () => {
  await assert.rejects(fetchPublic("https://example.invalid", {}, { attempts: 1, fetchImpl: async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); } }), (error) => error.code === "TimeoutError" && !error.message.includes("example.invalid"));
});

test("invalid TED response is rejected without partial records", async () => {
  await assert.rejects(fetchTedDay("2026-08-18", { fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => Buffer.from("not-json") }) }), SyntaxError);
});

test("withdrawn source evidence is preserved as lifecycle state", () => {
  const row = normalizeDoeRelease({ id: "withdrawn-1", date: "2026-08-17T08:00:00Z", tag: ["tenderCancellation"], buyer: { name: "Stadt" }, tender: { title: "Aufgehobenes Verfahren", items: [], lots: [] } });
  assert.equal(row.sourceLifecycleStatus, "WITHDRAWN");
});

test("database persistence leaves generated search fields to PostgreSQL and resolves replayed quarantines", () => {
  assert.doesNotMatch(ingestionSource, /search_document\s*[=,)]/);
  assert.match(ingestionSource, /retry_status='SUCCEEDED',manual_review_status='RESOLVED'/);
  assert.match(ingestionSource, /rawPayload\.processing_status !== "QUARANTINED"/);
  assert.match(ingestionSource, /classification_status='PENDING'/);
  assert.match(ingestionSource, /PARTIAL_FAILURE/);
  assert.doesNotMatch(ingestionSource, /const today =/);
});

test("source management view reports the authoritative current scheduler outcome", () => {
  assert.match(serverSource, /LEFT JOIN tender\.scheduler_worker_status scheduler ON scheduler\.source_code=source\.code/);
  assert.match(serverSource, /coalesce\(scheduler\.last_success_at,source\.last_success_at\) last_success_at/);
  assert.match(serverSource, /coalesce\(scheduler\.last_run_status,source\.last_status\) last_status/);
});
