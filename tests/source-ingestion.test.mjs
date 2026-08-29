import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import JSZip from "jszip";
import { assessDoeRequiredFields, berlinDay, consolidateDoeReleases, dailyWindow, dueSource, fetchDoeDay, fetchPublic, fetchTedDay, nextBerlinRun, normalizeDoeRelease, normalizeTedNotice } from "../platform/source-ingestion.mjs";

const ingestionSource = readFileSync(new URL("../platform/source-ingestion.mjs", import.meta.url), "utf8");
const ingestionEntrypoint = readFileSync(new URL("../deployment/wb-tender-ingestion-entrypoint", import.meta.url), "utf8");

test("production ingestion entrypoint invokes the ESM main module by absolute path", () => {
  assert.match(ingestionEntrypoint, /exec node \/app\/platform\/source-ingestion\.mjs/);
  assert.doesNotMatch(ingestionEntrypoint, /exec node platform\/source-ingestion\.mjs/);
});

test("TED normalizer preserves public source identity and German matching fields", () => {
  const row = normalizeTedNotice({
    "publication-number": "123456-2026", "publication-date": "2026-08-17+02:00",
    "notice-type":"cn-standard",
    "notice-title": { deu: "Wartung von Zutrittskontrollanlagen" },
    "buyer-name": { deu: ["Stadt Beispiel"] }, "classification-cpv": ["50610000", "50610000"],
    "place-of-performance": ["DE2", "DE2"], "identifier-lot":["LOT-1"], "deadline-receipt-tender-date-lot": ["2026-09-15+02:00"], "deadline-receipt-tender-time-lot":["10:00:00+02:00"],
    links: { xml: { MUL: "https://ted.europa.eu/en/notice/123456-2026/xml" } },
  }, "2026-08-17T12:00:00Z");
  assert.deepEqual({ id: row.externalId, buyer: row.buyer, cpv: row.cpvCodes, regions: row.regions, deadline: row.offerDeadline }, { id: "123456-2026", buyer: "Stadt Beispiel", cpv: ["50610000"], regions: ["DE2"], deadline: "2026-09-15T08:00:00.000Z" });
});

test("TED search multi-values are never aggregated through their latest lot deadline", () => {
  const row = normalizeTedNotice({
    "publication-number": "lot-deadlines", "notice-title": { deu: "Test" },
    "buyer-name": { deu: "Buyer" }, "deadline-receipt-tender-date-lot": ["2026-01-15T10:00:00+01:00", "2026-02-15T10:00:00+01:00"],
    links: { html: { DEU: "https://example.invalid" } },
  }, "2026-01-01T00:00:00Z");
  assert.equal(row.offerDeadline, null);
  assert.equal(row.sourceLifecycleStatus, "REVIEW_REQUIRED");
  assert.equal(row.participationStatus, "REVIEW_REQUIRED");
});

test("TED normalizer does not invent a time for date-only eForms evidence", () => {
  const row = normalizeTedNotice({
    "publication-number": "date-only-offset", "publication-date": "2026-08-20+02:00",
    "notice-title": { deu: "Test" }, "buyer-name": { deu: "Buyer" },
    "notice-type": "cn-standard",
    "deadline-receipt-tender-date-lot": ["2026-08-21+02:00", "2026-08-28+02:00"],
    links: { html: { DEU: "https://example.invalid" } },
  }, "2026-08-20T12:00:00Z");
  assert.equal(row.offerDeadline, null);
  assert.equal(row.sourceLifecycleStatus, "REVIEW_REQUIRED");
  assert.equal(row.participationStatus, "REVIEW_REQUIRED");
  assert.equal(row.deadlineEvidence.every((item) => item.normalizedUtc === null), true);
});

test("TED date-only parser rejects malformed deadline evidence fail-closed", () => {
  const row = normalizeTedNotice({
    "publication-number": "bad-date", "publication-date": "2026-08-20",
    "notice-title": { deu: "Test" }, "buyer-name": { deu: "Buyer" },
    "notice-type": "cn-standard", "deadline-receipt-tender-date-lot": ["not-a-date"],
    links: { html: { DEU: "https://example.invalid" } },
  }, "2026-08-20T12:00:00Z");
  assert.equal(row.offerDeadline, null);
  assert.equal(row.sourceLifecycleStatus, "REVIEW_REQUIRED");
});

test("DOE normalizer uses only supplied production notice evidence", () => {
  const row = normalizeDoeRelease({ id: "notice-1", uri: "https://oeffentlichevergabe.de/api/notices/notice-1?format=ocds", date: "2026-08-17T08:00:00Z", buyer: { name: "Landkreis Beispiel" }, tender: { title: "Hausmeister- und Winterdienst", description: "Facility Management", tenderPeriod: { endDate: "2026-09-20T10:00:00Z" }, items: [{ classification: { id: "90620000" }, deliveryAddress: { region: "DE2" } }], lots: [] } });
  assert.equal(row.title, "Hausmeister- und Winterdienst");
  assert.deepEqual(row.cpvCodes, ["90620000"]);
  assert.deepEqual(row.regions, ["DE2"]);
});

test("DOE normalizer derives only the documented public notice endpoint when exports omit uri", () => {
  const row = normalizeDoeRelease({ id: "d4d4c81d-6b1d-4908-8693-1d8df51baf1d", date: "2026-08-15T22:06:05Z", buyer: { name: "Stadt Beispiel" }, tender: { title: "Öffentlicher Auftrag", items: [], lots: [] } });
  assert.equal(row.sourceUrl, "https://oeffentlichevergabe.de/api/notices/d4d4c81d-6b1d-4908-8693-1d8df51baf1d?format=ocds");
  assert.equal(row.publicationDate, "2026-08-15");
});

test("DOE required-field assessment is generic and reports no tender content", () => {
  assert.deepEqual(assessDoeRequiredFields({ id: "incomplete-title", buyer: { name: "Buyer" }, tender: { description: "Content" } }), {
    importable: false, externalId: "incomplete-title", missingFields: ["title"],
  });
  assert.deepEqual(assessDoeRequiredFields({ id: "incomplete-buyer", tender: { title: "Title" } }), {
    importable: false, externalId: "incomplete-buyer", missingFields: ["buyer"],
  });
});

test("DOE release consolidation chooses one uniquely newest authoritative version", () => {
  const result = consolidateDoeReleases([
    { id: "same", date: "2026-08-19T10:22:05Z", tender: { title: "Earlier" } },
    { id: "same", date: "2026-08-19T10:50:04Z", tender: { title: "Latest" } },
  ]);
  assert.equal(result.sourceRecordCount, 2);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].tender.title, "Latest");
  assert.equal(result.assessments[0].status, "CONSOLIDATED_TO_LATEST_AUTHORITATIVE_RELEASE");
});

test("DOE release consolidation fails closed for different versions without a unique latest timestamp", () => {
  const result = consolidateDoeReleases([
    { id: "same", date: "2026-08-19T10:22:05Z", tender: { title: "A" } },
    { id: "same", date: "2026-08-19T10:22:05Z", tender: { title: "B" } },
  ]);
  assert.equal(result.records.length, 1);
  assert.equal(result.assessments[0].status, "AMBIGUOUS_SOURCE_VERSIONS");
});

test("DOE fetch resolves incomplete export records from authoritative detail and terminally assesses still incomplete evidence", async () => {
  const zip = new JSZip();
  zip.file("notices.json", JSON.stringify({ releases: [
    { id: "resolved", buyer: { name: "Buyer" }, tender: { description: "Description" } },
    { id: "terminal", buyer: { name: "Buyer" }, tender: { description: "Description" } },
  ] }));
  const archive = await zip.generateAsync({ type: "nodebuffer" });
  const detail = {
    resolved: { releases: [{ id: "resolved", buyer: { name: "Buyer" }, tender: { title: "Recovered" } }] },
    terminal: { releases: [{ id: "terminal", buyer: { name: "Buyer" }, tender: { description: "Still incomplete" } }] },
  };
  const fetched = await fetchDoeDay("2026-08-19", { fetchImpl: async (url) => {
    const body = url.includes("notice-exports") ? archive : Buffer.from(JSON.stringify(detail[url.includes("terminal") ? "terminal" : "resolved"]));
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => body };
  } });
  assert.equal(fetched.pages.length, 3);
  assert.equal(fetched.records[0].tender.title, "Recovered");
  assert.equal(fetched.recordAssessments[0].status, "RESOLVED_FROM_AUTHORITATIVE_DETAIL");
  assert.deepEqual({ status: fetched.recordAssessments[1].status, missing: fetched.recordAssessments[1].missingFields }, { status: "AUTHORITATIVE_NON_IMPORTABLE", missing: ["title"] });
  assert.deepEqual(fetched.recordPageIndexes, [1, 2]);
});

test("DOE fetch remains fail-closed when authoritative detail is unavailable or ambiguous", async () => {
  const zip = new JSZip();
  zip.file("notices.json", JSON.stringify({ releases: [{ id: "unresolved", buyer: { name: "Buyer" }, tender: {} }] }));
  const archive = await zip.generateAsync({ type: "nodebuffer" });
  const fetched = await fetchDoeDay("2026-08-19", { fetchImpl: async (url) => url.includes("notice-exports")
    ? { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => archive }
    : { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) } });
  assert.equal(fetched.recordAssessments[0], null);
  assert.equal(fetched.recordPageIndexes[0], 0);
  assert.throws(() => normalizeDoeRelease(fetched.records[0]), (error) => error.code === "DOE_REQUIRED_FIELD_MISSING");
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

test("daily TED fetch captures authoritative XML lot deadlines without mutating search payload",async()=>{
  const search={notices:[{"publication-number":"123456-2026","publication-date":"2026-08-18","notice-title":{deu:"Test"},"buyer-name":{deu:["Stadt"]},"notice-type":"cn-standard","deadline-receipt-tender-date-lot":["2026-09-15+02:00"],links:{xml:{MUL:"https://ted.europa.eu/en/notice/123456-2026/xml"}}}]};
  const xml=`<ContractNotice><ProcurementProjectLot><ID>LOT-1</ID><TenderingProcess><TenderSubmissionDeadlinePeriod><EndDate>2026-09-15+02:00</EndDate><EndTime>10:00:00+02:00</EndTime></TenderSubmissionDeadlinePeriod></TenderingProcess></ProcurementProjectLot></ContractNotice>`;
  let call=0;const fetched=await fetchTedDay("2026-08-18",{fetchImpl:async()=>{call++;const payload=call===1?JSON.stringify(search):xml;return{ok:true,status:200,headers:{get:()=>null},arrayBuffer:async()=>Buffer.from(payload)}}});
  assert.equal(fetched.pages.length,2);assert.equal(fetched.pages[1].contentType,"application/xml");
  const normalized=normalizeTedNotice(fetched.records[0],"2026-08-18T12:00:00Z");
  assert.equal(normalized.offerDeadline,"2026-09-15T08:00:00.000Z");assert.equal(normalized.lotLifecycles[0].lotKey,"LOT-1");
  assert.equal(JSON.stringify(fetched.records[0]).includes("__wbDeadlineEvidence"),false);
});

test("TED XML evidence fetch reuses persisted evidence and bounds uncached rate-limited requests",async()=>{
  const notices=["cached-2026","fresh-2026"].map((id)=>({"publication-number":id,"publication-date":"2026-08-18","notice-title":{deu:"Test"},"buyer-name":{deu:["Stadt"]},"notice-type":"cn-standard","deadline-receipt-tender-date-lot":["2026-09-15+02:00"],links:{xml:{MUL:`https://ted.europa.eu/en/notice/${id}/xml`}}}));
  const xml=(id)=>Buffer.from(`<ContractNotice><ProcurementProjectLot><ID>${id}</ID><TenderingProcess><TenderSubmissionDeadlinePeriod><EndDate>2026-09-15+02:00</EndDate><EndTime>10:00:00+02:00</EndTime></TenderSubmissionDeadlinePeriod></TenderingProcess></ProcurementProjectLot></ContractNotice>`);
  let searchCalls=0,xmlCalls=0;
  const fetched=await fetchTedDay("2026-08-18",{
    xmlEvidenceLookup:async(ids)=>{assert.deepEqual(ids,["cached-2026","fresh-2026"]);return new Map([["cached-2026",{rawBytes:xml("cached-2026"),responseCursor:"v1"}]]);},
    fetchImpl:async(url)=>{if(url.includes("/v3/notices/search")){searchCalls++;return{ok:true,status:200,headers:{get:()=>null},arrayBuffer:async()=>Buffer.from(JSON.stringify({notices}))};}xmlCalls++;return{ok:true,status:200,headers:{get:()=>null},arrayBuffer:async()=>xml("fresh-2026")};}
  });
  assert.equal(searchCalls,1);assert.equal(xmlCalls,1);assert.equal(fetched.pages.filter((page)=>page.contentType==="application/xml").length,2);
  assert.equal(normalizeTedNotice(fetched.records[0],"2026-08-18T12:00:00Z").lotLifecycles[0].lotKey,"cached-2026");
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

test("daily lifecycle rollover expires exact elapsed lots before inbox matching and audits transitions", () => {
  assert.match(ingestionSource, /export async function expireElapsedLifecycleDeadlines/);
  assert.match(ingestionSource, /l\.deadline_quality='EXACT'.*l\.offer_deadline<=\$1/s);
  assert.match(ingestionSource, /'LOT_DEADLINE_EXPIRED'.*notice_lifecycle_transitions/s);
  assert.match(ingestionSource, /'LOT_DEADLINE_ROLLOVER'/);
  assert.ok(ingestionSource.indexOf("expireElapsedLifecycleDeadlines(pool") < ingestionSource.indexOf("runInboxPipeline(pool"));
  assert.doesNotMatch(ingestionSource, /UPDATE tender\.tenders SET source_lifecycle_status='EXPIRED'.*offer_deadline<now\(\)/s);
});
