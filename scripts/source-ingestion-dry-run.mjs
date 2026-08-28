import { readFileSync } from "node:fs";
import pg from "pg";
import { dailyWindow, fetchDoeDay, fetchTedDay, normalizeDoeRelease, normalizeTedNotice, PUBLIC_SOURCES } from "../platform/source-ingestion.mjs";

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const nextDay = (day) => {
  const value = new Date(`${day}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
};
const connectionString = process.env.DATABASE_URL || readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim();
const sources = String(process.env.INGESTION_SOURCES || "TED,DOE").split(",").map((value) => value.trim().toUpperCase()).filter((value) => PUBLIC_SOURCES.includes(value));
const defaults = dailyWindow(), from = process.env.INGESTION_FROM || defaults.from, to = process.env.INGESTION_TO || from;
if (!sources.length || !dayPattern.test(from) || !dayPattern.test(to) || to < from) throw new Error("invalid dry-run configuration");
const pool = new pg.Pool({ connectionString, max: 1, options: "-c default_transaction_read_only=on" });
const output = [];
try {
  for (const sourceCode of sources) for (let day = from; day <= to; day = nextDay(day)) {
    const fetched = sourceCode === "TED" ? await fetchTedDay(day) : await fetchDoeDay(day);
    const normalized = [], rejected = [];
    for (const raw of fetched.records) try {
      normalized.push(sourceCode === "TED" ? normalizeTedNotice(raw) : normalizeDoeRelease(raw));
    } catch (error) { rejected.push(String(error.code || "NORMALIZATION_FAILED")); }
    const ids = normalized.map((row) => row.externalId), prior = ids.length ? (await pool.query("SELECT external_id,raw_sha256 FROM tender.tenders WHERE source_code=$1 AND external_id=ANY($2::text[])", [sourceCode, ids])).rows : [];
    const hashes = new Map(prior.map((row) => [row.external_id, row.raw_sha256]));
    const counts = { read: fetched.records.length, new: 0, updated: 0, unchanged: 0, rejected: rejected.length };
    for (const row of normalized) if (!hashes.has(row.externalId)) counts.new += 1; else if (hashes.get(row.externalId) === row.rawSha256) counts.unchanged += 1; else counts.updated += 1;
    output.push({ sourceCode, day, pages: fetched.pages.length, counts, retryCount: fetched.retryCount, rateLimitCount: fetched.rateLimitCount });
  }
  console.log(JSON.stringify({ passed: output.every((item) => item.counts.rejected === 0), writeAccess: false, externalSubmission: false, results: output }));
} finally { await pool.end(); }
