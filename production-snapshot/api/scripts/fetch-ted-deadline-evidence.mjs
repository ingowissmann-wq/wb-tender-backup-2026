import crypto from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseTedEformsXmlDeadlines } from "../platform/tender-deadlines.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function retryAfterMilliseconds(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

export function retryDelayMilliseconds({ attempt, retryAfter, random = Math.random, now = Date.now(), baseMs = 2_000, maximumMs = 120_000 }) {
  const exponential = Math.min(maximumMs, baseMs * (2 ** attempt));
  const jitter = Math.floor(exponential * 0.25 * Math.max(0, Math.min(1, random())));
  return Math.min(maximumMs, Math.max(retryAfterMilliseconds(retryAfter, now), exponential + jitter));
}

export async function fetchTedXmlEvidence(notice, {
  fetchImpl = fetch,
  sleep = defaultSleep,
  random = Math.random,
  maximumAttempts = 8,
  metrics = { http429: 0, retries: 0 },
} = {}) {
  const url = notice.sourceUrl && /ted\.europa\.eu/i.test(notice.sourceUrl)
    ? notice.sourceUrl
    : `https://ted.europa.eu/en/notice/${encodeURIComponent(notice.externalId)}/xml`;
  let last;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/xml,text/xml", "user-agent": "WB-Tender-Lifecycle-ReadOnly-Evidence/2.0" },
        signal: AbortSignal.timeout(45_000),
      });
      if (response.ok) {
        const xml = await response.text(), xmlSha256 = sha256(xml);
        const deadlines = parseTedEformsXmlDeadlines(xml, {
          sourceNoticeId: notice.externalId,
          procedureIdentifier: notice.procedureIdentifier || null,
          sourceTimestamp: notice.sourceTimestamp || null,
          sourceVersion: notice.sourceVersion || null,
          sourceKind: "TED_EFORMS_XML",
        });
        return {
          sourceCode: "TED", externalId: notice.externalId, sourceUrl: url, fetchStatus: "SUCCEEDED",
          xmlSha256, sourceTimestamp: notice.sourceTimestamp || null, sourceVersion: notice.sourceVersion || null,
          attempts: attempt + 1, deadlines,
        };
      }
      if (response.status === 429) metrics.http429 += 1;
      last = new Error(`TED XML HTTP ${response.status}`);
      if (response.status < 500 && response.status !== 429) break;
      if (attempt + 1 < maximumAttempts) {
        metrics.retries += 1;
        await sleep(retryDelayMilliseconds({ attempt, retryAfter: response.headers.get("retry-after"), random }));
      }
    } catch (error) {
      last = error;
      if (attempt + 1 < maximumAttempts) {
        metrics.retries += 1;
        await sleep(retryDelayMilliseconds({ attempt, retryAfter: null, random }));
      }
    }
  }
  return {
    sourceCode: "TED", externalId: notice.externalId, sourceUrl: url, fetchStatus: "FAILED",
    safeError: String(last?.message || "TED XML fetch failed").slice(0, 120), attempts: maximumAttempts, deadlines: [],
  };
}

const atomicWriteJson = (path, value) => {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
};

export async function runEvidenceFetch({ env = process.env, fetchImpl = fetch, sleep = defaultSleep, random = Math.random } = {}) {
  const inputPath = env.TED_DEADLINE_NOTICE_FILE, outputPath = env.NOTICE_DEADLINE_EVIDENCE_FILE;
  const progressPath = env.TED_DEADLINE_PROGRESS_FILE || `${outputPath}.progress.json`;
  if (!inputPath || !outputPath) throw new Error("TED_DEADLINE_NOTICE_FILE and NOTICE_DEADLINE_EVIDENCE_FILE are required");
  if (existsSync(outputPath)) throw new Error("final evidence output already exists");
  const notices = JSON.parse(readFileSync(inputPath, "utf8"));
  if (!Array.isArray(notices)) throw new Error("deadline notice input must be an array");
  const concurrency = Math.max(1, Math.min(4, Number(env.TED_DEADLINE_FETCH_CONCURRENCY || 1)));
  const maximumAttempts = Math.max(1, Math.min(12, Number(env.TED_DEADLINE_FETCH_MAX_ATTEMPTS || 8)));
  const minimumInterval = Math.max(250, Math.min(10_000, Number(env.TED_DEADLINE_MIN_INTERVAL_MS || 750)));
  const prior = existsSync(progressPath) ? JSON.parse(readFileSync(progressPath, "utf8")) : { schema: "wb-ted-evidence-progress/v1", results: {} };
  if (prior.schema !== "wb-ted-evidence-progress/v1" || !prior.results || typeof prior.results !== "object") throw new Error("invalid evidence progress file");
  const metrics = { http429: Number(prior.http429 || 0), retries: Number(prior.retries || 0) };
  const pending = notices.filter((notice) => prior.results[notice.externalId]?.fetchStatus !== "SUCCEEDED");
  let cursor = 0, completedThisRun = 0;
  const persist = () => atomicWriteJson(progressPath, {
    schema: prior.schema, inputSha256: sha256(JSON.stringify(notices)), updatedAt: new Date().toISOString(),
    http429: metrics.http429, retries: metrics.retries, results: prior.results,
  });
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= pending.length) return;
      const notice = pending[index];
      const result = await fetchTedXmlEvidence(notice, { fetchImpl, sleep, random, maximumAttempts, metrics });
      prior.results[notice.externalId] = result;
      completedThisRun += 1;
      persist();
      if (completedThisRun % 25 === 0) process.stderr.write(`${completedThisRun}/${pending.length}\n`);
      await sleep(minimumInterval + Math.floor(minimumInterval * 0.2 * random()));
    }
  }));
  const results = notices.map((notice) => prior.results[notice.externalId]).filter(Boolean)
    .sort((a, b) => `${a.sourceCode}:${a.externalId}`.localeCompare(`${b.sourceCode}:${b.externalId}`));
  atomicWriteJson(outputPath, results);
  const report = {
    mode: "READ_ONLY_PUBLIC_EVIDENCE_FETCH", notices: notices.length, resumedFromCache: notices.length - pending.length,
    attemptedThisRun: pending.length, succeeded: results.filter((item) => item.fetchStatus === "SUCCEEDED").length,
    failed: results.filter((item) => item.fetchStatus === "FAILED").length,
    exact: results.flatMap((item) => item.deadlines || []).filter((item) => item.parsingStatus === "EXACT").length,
    http429: metrics.http429, retries: metrics.retries, outputSha256: sha256(JSON.stringify(results)), progressPath,
  };
  console.log(JSON.stringify(report));
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) await runEvidenceFetch();
