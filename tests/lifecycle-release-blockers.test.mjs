import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { aggregateLotLifecycle, assessLotDeadlines, parseAuthoritativeDeadline, parseTedEformsXmlDeadlines } from "../platform/tender-deadlines.mjs";
import { buildLifecyclePlan } from "../platform/lifecycle-plan.mjs";
import { fetchTedXmlEvidence, retryAfterMilliseconds, runEvidenceFetch } from "../scripts/fetch-ted-deadline-evidence.mjs";

const asOf = new Date("2026-08-20T12:00:00Z");
const exact = (date, time, lotKey = "LOT-1") => parseAuthoritativeDeadline({ sourceDate: date, sourceTime: time, lotKey, sourceNoticeId: "fixture", sourceKind: "TEST" });

test("TED CEST, CET, UTC and explicit offsets preserve their exact instant", () => {
  assert.equal(exact("2026-07-08+02:00", "12:00:00+02:00").normalizedUtc, "2026-07-08T10:00:00.000Z");
  assert.equal(exact("2026-01-08+01:00", "12:00:00+01:00").normalizedUtc, "2026-01-08T11:00:00.000Z");
  assert.equal(exact("2026-07-08Z", "12:00:00Z").normalizedUtc, "2026-07-08T12:00:00.000Z");
  assert.equal(exact("2026-07-08+0530", "12:00:00+0530").normalizedUtc, "2026-07-08T06:30:00.000Z");
});

test("date-only, invalid time, missing timezone and conflicting offsets fail closed", () => {
  assert.deepEqual([parseAuthoritativeDeadline({ sourceDate: "2026-09-01+02:00" }).parsingStatus, parseAuthoritativeDeadline({ sourceDate: "2026-09-01+02:00" }).normalizedUtc], ["DATE_ONLY", null]);
  assert.equal(exact("2026-09-01+02:00", "25:61:00+02:00").parsingStatus, "INVALID");
  assert.equal(exact("2026-09-01", "12:00:00").decisionReason, "DEADLINE_TIMEZONE_MISSING");
  assert.equal(exact("2026-09-01+02:00", "12:00:00+01:00").parsingStatus, "AMBIGUOUS");
});

test("Europe/Berlin summer, winter and DST boundaries render correctly", () => {
  assert.match(exact("2026-03-29+02:00", "03:15:00+02:00").europeBerlin, /^2026-03-29T03:15:00/);
  assert.match(exact("2026-10-25+01:00", "03:15:00+01:00").europeBerlin, /^2026-10-25T03:15:00/);
  assert.equal(exact("2026-10-25+02:00", "02:30:00+02:00").normalizedUtc, "2026-10-25T00:30:00.000Z");
  assert.equal(exact("2026-10-25+01:00", "02:30:00+01:00").normalizedUtc, "2026-10-25T01:30:00.000Z");
});

test("377489-2026 XML binds 08.07.2026 12:00 CEST to its lot", () => {
  const xml = `<ContractNotice><ProcurementProjectLot><ID>LOT-0001</ID><TenderingTerms><TenderSubmissionDeadlinePeriod><EndDate>2026-07-08+02:00</EndDate><EndTime>12:00:00+02:00</EndTime></TenderSubmissionDeadlinePeriod></TenderingTerms></ProcurementProjectLot></ContractNotice>`;
  const deadlines = parseTedEformsXmlDeadlines(xml, { sourceNoticeId: "377489-2026", sourceVersion: "01", sourceKind: "TED_EFORMS_XML" });
  assert.equal(deadlines.length, 1); assert.equal(deadlines[0].lotKey, "LOT-0001"); assert.equal(deadlines[0].normalizedUtc, "2026-07-08T10:00:00.000Z");
});

test("single future and expired lots receive independent lifecycle decisions", () => {
  assert.equal(assessLotDeadlines({ classification: "COMPETITION", evidence: [exact("2026-09-01+02:00", "12:00:00+02:00")], now: asOf })[0].participationStatus, "ELIGIBLE");
  assert.equal(assessLotDeadlines({ classification: "COMPETITION", evidence: [exact("2026-07-01+02:00", "12:00:00+02:00")], now: asOf })[0].participationStatus, "NOT_ELIGIBLE");
});

test("multiple lots with equal or different valid deadlines remain lot-bound", () => {
  const evidence = [exact("2026-09-01+02:00", "12:00:00+02:00", "LOT-1"), exact("2026-10-01+02:00", "12:00:00+02:00", "LOT-2")];
  const lots = assessLotDeadlines({ classification: "COMPETITION", evidence, now: asOf });
  assert.deepEqual(lots.map((lot) => [lot.lotKey, lot.participationStatus]), [["LOT-1", "ELIGIBLE"], ["LOT-2", "ELIGIBLE"]]);
  assert.equal(aggregateLotLifecycle(lots).participationStatus, "ELIGIBLE");
});

test("mixed past and future lots aggregate only as partially eligible", () => {
  const lots = assessLotDeadlines({ classification: "COMPETITION", evidence: [exact("2026-07-01+02:00", "12:00:00+02:00", "PAST"), exact("2026-09-01+02:00", "12:00:00+02:00", "FUTURE")], now: asOf });
  const aggregate = aggregateLotLifecycle(lots);
  assert.deepEqual(lots.map((lot) => lot.participationStatus), ["ELIGIBLE", "NOT_ELIGIBLE"].sort());
  assert.equal(aggregate.sourceLifecycleStatus, "ACTIVE"); assert.equal(aggregate.participationStatus, "PARTIALLY_ELIGIBLE");
});

test("conflicts within one lot and deadlines without lot binding require review", () => {
  const conflict = assessLotDeadlines({ classification: "COMPETITION", evidence: [exact("2026-09-01+02:00", "12:00:00+02:00", "LOT-1"), exact("2026-09-02+02:00", "12:00:00+02:00", "LOT-1")], now: asOf })[0];
  assert.equal(conflict.participationStatus, "REVIEW_REQUIRED"); assert.equal(conflict.blockReason, "CONFLICTING_DEADLINES_WITHIN_LOT");
  const unbound = assessLotDeadlines({ classification: "COMPETITION", evidence: [{ ...exact("2026-09-01+02:00", "12:00:00+02:00"), lotKey: null }], now: asOf })[0];
  assert.equal(unbound.participationStatus, "REVIEW_REQUIRED"); assert.equal(unbound.blockReason, "DEADLINE_LOT_BINDING_REQUIRED");
});

test("unbound date-only evidence may expire safely but can never activate",()=>{
  const past={...parseAuthoritativeDeadline({sourceDate:"2026-07-01+02:00",sourceNoticeId:"past"}),lotKey:null,parsingStatus:"UNBOUND",decisionReason:"TED_SEARCH_MULTIVALUE_LOT_BINDING_UNPROVEN"};
  const future={...parseAuthoritativeDeadline({sourceDate:"2026-09-01+02:00",sourceNoticeId:"future"}),lotKey:null,parsingStatus:"UNBOUND",decisionReason:"TED_SEARCH_MULTIVALUE_LOT_BINDING_UNPROVEN"};
  assert.equal(assessLotDeadlines({classification:"COMPETITION",evidence:[past],now:asOf})[0].lifecycleStatus,"EXPIRED");
  assert.equal(assessLotDeadlines({classification:"COMPETITION",evidence:[future],now:asOf})[0].participationStatus,"REVIEW_REQUIRED");
});

test("terminal notices and completed lots ignore future contract-like dates", () => {
  for (const classification of ["RESULT", "CONTRACT_MODIFICATION", "VOLUNTARY_EX_ANTE"]) {
    const lot = assessLotDeadlines({ classification, evidence: [exact("2036-09-30+02:00", "12:00:00+02:00")], now: asOf })[0];
    assert.equal(lot.lifecycleStatus, "CLOSED"); assert.equal(lot.participationStatus, "NOT_ELIGIBLE");
  }
});

const syntheticRows = () => [{ id: "00000000-0000-4000-8000-000000000001", source_code: "TED", external_id: "fixture", publication_date: "2026-08-01", offer_deadline: null, source_timestamp: "2026-08-01T10:00:00Z", source_lifecycle_status: "ACTIVE", current_notice_classification: null, current_participation_status: null, status: null, raw_sha256: "a".repeat(64), normalized_data: { sourceStatus: "cn-standard", raw: { "notice-type": "cn-standard" } } }];

test("dry-run, gate and apply use the same canonical plan hash and detect input drift", () => {
  const options = { asOf, deadlineEvidence: [{ sourceCode: "TED", externalId: "fixture", deadlines: [exact("2026-09-01+02:00", "12:00:00+02:00")] }] };
  const dryRun = buildLifecyclePlan(syntheticRows(), options), gate = buildLifecyclePlan(syntheticRows(), options), apply = buildLifecyclePlan(syntheticRows(), options);
  assert.equal(dryRun.planSha256, gate.planSha256); assert.equal(gate.planSha256, apply.planSha256);
  const changed = syntheticRows(); changed[0].raw_sha256 = "b".repeat(64);
  assert.notEqual(buildLifecyclePlan(changed, options).planSha256, dryRun.planSha256);
});

test("574224-2026 closes 377489-2026 and contract duration never becomes a deadline", () => {
  const competition = { ...syntheticRows()[0], external_id: "377489-2026", normalized_data: { sourceStatus: "cn-standard", raw: { "notice-type": "cn-standard" } } };
  const result = { ...syntheticRows()[0], id: "00000000-0000-4000-8000-000000000002", external_id: "574224-2026", normalized_data: { sourceStatus: "can-standard", raw: { "notice-type": "can-standard", "previous-notice-id-proc": ["377489-2026"], "contract-period-start": "2026-10-01", "contract-period-end": "2036-09-30" } } };
  const plan = buildLifecyclePlan([competition, result], { asOf, deadlineEvidence: [{ sourceCode: "TED", externalId: "377489-2026", deadlines: [exact("2026-07-08+02:00", "12:00:00+02:00", "LOT-0000")] }] });
  assert.deepEqual(plan.rows.map((row) => [row.externalId, row.toLifecycle, row.toParticipation]), [["377489-2026", "CLOSED", "NOT_ELIGIBLE"], ["574224-2026", "CLOSED", "NOT_ELIGIBLE"]]);
  assert.equal(plan.rows.find((row) => row.externalId === "574224-2026").deadlineTo, null);
});

test("a correctly configured isolated sixth company remains in its own scope", () => {
  const companies = [{ id: "cleaning", name: "WB-Cleaning", profile: "p1" }, { id: "sixth", name: "ISOLATED-SIXTH-COMPANY", profile: "p6" }];
  const scopes = [{ company: "cleaning", profile: "p1", service: "cleaning" }, { company: "sixth", profile: "p6", service: "security" }];
  const relevance = [{ company: "cleaning", tender: "t1", lot: "LOT-1", service: "cleaning" }, { company: "sixth", tender: "t6", lot: "LOT-6", service: "security" }];
  const eligibleLots = [{ tender: "t1", lot: "LOT-1" }, { tender: "t6", lot: "LOT-6" }];
  const activeContexts = relevance.filter((context) => {
    const company = companies.find((item) => item.id === context.company);
    return company
      && scopes.some((scope) => scope.company === company.id && scope.profile === company.profile && scope.service === context.service)
      && eligibleLots.some((lot) => lot.tender === context.tender && lot.lot === context.lot);
  });
  assert.deepEqual(activeContexts.filter((row) => row.company === "sixth"), [{ company: "sixth", tender: "t6", lot: "LOT-6", service: "security" }]);
  assert.equal(activeContexts.filter((row) => row.company === "cleaning").length, 1);
});

test("TED evidence fetch honors Retry-After and retries HTTP 429 with bounded jitter", async () => {
  assert.equal(retryAfterMilliseconds("7", 0), 7_000);
  const sleeps = [], metrics = { http429: 0, retries: 0 };
  let calls = 0;
  const xml = `<ContractNotice><ProcurementProjectLot><ID>LOT-1</ID><TenderingTerms><TenderSubmissionDeadlinePeriod><EndDate>2026-09-01+02:00</EndDate><EndTime>12:00:00+02:00</EndTime></TenderSubmissionDeadlinePeriod></TenderingTerms></ProcurementProjectLot></ContractNotice>`;
  const result = await fetchTedXmlEvidence({ externalId: "fixture" }, {
    fetchImpl: async () => ++calls === 1
      ? new Response("limited", { status: 429, headers: { "retry-after": "7" } })
      : new Response(xml, { status: 200 }),
    sleep: async (milliseconds) => sleeps.push(milliseconds), random: () => 0, metrics,
  });
  assert.equal(result.fetchStatus, "SUCCEEDED");
  assert.equal(result.deadlines[0].normalizedUtc, "2026-09-01T10:00:00.000Z");
  assert.deepEqual({ calls, sleeps, metrics }, { calls: 2, sleeps: [7_000], metrics: { http429: 1, retries: 1 } });
});

test("TED evidence progress resumes successful cached notices idempotently", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ted-evidence-resume-"));
  try {
    const input = join(directory, "input.json"), output = join(directory, "output.json"), progress = join(directory, "progress.json");
    const notices = [{ externalId: "cached" }, { externalId: "pending" }];
    const cached = { sourceCode: "TED", externalId: "cached", fetchStatus: "SUCCEEDED", xmlSha256: "a".repeat(64), deadlines: [] };
    writeFileSync(input, JSON.stringify(notices));
    writeFileSync(progress, JSON.stringify({ schema: "wb-ted-evidence-progress/v1", http429: 0, retries: 0, results: { cached } }));
    const xml = `<ContractNotice><ProcurementProjectLot><ID>LOT-2</ID><TenderingTerms><TenderSubmissionDeadlinePeriod><EndDate>2026-09-02+02:00</EndDate><EndTime>12:00:00+02:00</EndTime></TenderSubmissionDeadlinePeriod></TenderingTerms></ProcurementProjectLot></ContractNotice>`;
    let calls = 0;
    const report = await runEvidenceFetch({
      env: { TED_DEADLINE_NOTICE_FILE: input, NOTICE_DEADLINE_EVIDENCE_FILE: output, TED_DEADLINE_PROGRESS_FILE: progress, TED_DEADLINE_FETCH_CONCURRENCY: "1" },
      fetchImpl: async () => { calls += 1; return new Response(xml, { status: 200 }); }, sleep: async () => {}, random: () => 0,
    });
    assert.equal(report.resumedFromCache, 1); assert.equal(report.attemptedThisRun, 1); assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")).map((item) => item.externalId), ["cached", "pending"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
