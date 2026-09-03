import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";

const base = process.env.PERF_BASE_URL;
const cookieFile = process.env.PERF_COOKIE_FILE;
const databaseUrlFile = process.env.PERF_DATABASE_URL_FILE;
const minimumItems = Number(process.env.PERF_MIN_ITEMS || 1000);
const timeoutMs = Number(process.env.PERF_TIMEOUT_MS || 5000);
assert.ok(/^https:\/\//.test(base || "") || /^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(base || ""), "PERF_BASE_URL must be HTTPS or loopback HTTP");
assert.ok(cookieFile, "PERF_COOKIE_FILE is required");
assert.ok(databaseUrlFile, "PERF_DATABASE_URL_FILE is required");
assert.ok(minimumItems >= 1000, "performance data set must contain at least 1000 items");
assert.ok(timeoutMs > 0 && timeoutMs <= 10000, "timeout must be at most ten seconds");
const cookie = (await readFile(cookieFile, "utf8")).trim();
assert.ok(cookie && !/[\r\n]/.test(cookie), "cookie file is empty or malformed");
const databaseUrl = (await readFile(databaseUrlFile, "utf8")).trim();
const pool = new pg.Pool({ connectionString: databaseUrl, options: "-c default_transaction_read_only=on" });
try {
  for (const [name, sql, index] of [
    ["latest results", "SELECT DISTINCT ON(tender_id,company_id,lot_key) tender_id,company_id,lot_key,result_version FROM tender.autopilot_results ORDER BY tender_id,company_id,lot_key,result_version DESC LIMIT 5000", "autopilot_results_overview_latest_idx"],
    ["latest jobs", "SELECT DISTINCT ON(tender_id,company_id,lot_key) tender_id,company_id,lot_key,created_at FROM tender.autopilot_queue WHERE action_type='RUN_FULL_PIPELINE' ORDER BY tender_id,company_id,lot_key,created_at DESC LIMIT 5000", "autopilot_queue_full_pipeline_latest_idx"],
  ]) {
    const plan = (await pool.query(`EXPLAIN (FORMAT JSON, COSTS TRUE) ${sql}`)).rows[0]["QUERY PLAN"][0];
    assert.ok(JSON.stringify(plan).includes(index), `${name} plan does not use ${index}`);
  }
} finally {
  await pool.end();
}

const durations = [];
for (let run = 0; run < 5; run += 1) {
  const started = performance.now();
  const response = await fetch(`${base}/api/tender/autopilot/navigation/overview?relevance=relevant`, {
    headers: { cookie, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Number(body.total) >= minimumItems, `only ${body.total} items; large-data test is invalid`);
  durations.push(Math.round(performance.now() - started));
}
durations.sort((a, b) => a - b);
assert.ok(durations[4] < timeoutMs, `overview exceeded ${timeoutMs} ms`);
console.log(JSON.stringify({ passed: true, minimumItems, timeoutMs, runsMs: durations, p95Ms: durations[4] }));
