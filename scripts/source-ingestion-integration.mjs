import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { acquireLease, importFetchedDay } from "../platform/source-ingestion.mjs";

const connectionString = process.env.DATABASE_URL || readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim();
const pool = new pg.Pool({ connectionString, max: 4 });
const page = (day, suffix = "") => ({ pageIndex: 0, sourceUrl: `https://oeffentlichevergabe.de/api/notice-exports?pubDay=${day}&format=ocds.zip`, contentType: "application/zip", rawBytes: Buffer.from(`isolated-${day}-${suffix}`), requestCursor: day, responseCursor: day });
const release = ({ id, title = "Unterhaltsreinigung", description = "Gebäudereinigung", cpv = "90911200", endDate = "2026-09-30T10:00:00Z", tag = ["tender"] } = {}) => ({ id, date: "2026-08-18T08:00:00Z", tag, buyer: { name: "Synthetic public buyer" }, tender: { title, description, status: tag.includes("tenderCancellation") ? "cancelled" : "active", tenderPeriod: endDate ? { endDate } : undefined, items: [{ classification: { id: cpv }, deliveryAddress: { region: "DE2" } }], lots: [] } });
const fetched = (day, records, suffix) => ({ sourceCode: "DOE", day, pages: [page(day, suffix)], records, recordPageIndexes: records.map(() => 0), cursorAfter: day, startedAt: new Date().toISOString(), retryCount: 0, rateLimitCount: 0 });

try {
  const first = await importFetchedDay(pool, fetched("2026-08-18", [release({ id: "sync-1" })], "first"));
  assert.deepEqual({ passed: first.passed, new: first.counts.new, updated: first.counts.updated, duplicate: first.counts.duplicate }, { passed: true, new: 1, updated: 0, duplicate: 0 });

  const repeated = await importFetchedDay(pool, fetched("2026-08-18", [release({ id: "sync-1" })], "repeat"));
  assert.equal(repeated.counts.duplicate, 1);
  assert.equal(Number((await pool.query("SELECT count(*) n FROM tender.tenders WHERE source_code='DOE' AND external_id='sync-1'")).rows[0].n), 1);

  const changed = await importFetchedDay(pool, fetched("2026-08-18", [release({ id: "sync-1", title: "Glasreinigung aktualisiert" })], "changed"));
  assert.equal(changed.counts.updated, 1);
  assert.equal(Number((await pool.query("SELECT count(*) n FROM tender.tender_versions version JOIN tender.tenders tender ON tender.id=version.tender_id WHERE tender.external_id='sync-1'")).rows[0].n), 2);

  const lifecycle = await importFetchedDay(pool, fetched("2026-08-19", [release({ id: "sync-expired", endDate: "2026-01-01T00:00:00Z" }), release({ id: "sync-withdrawn", tag: ["tenderCancellation"] })], "lifecycle"));
  assert.equal(lifecycle.counts.new, 2);
  const states = (await pool.query("SELECT external_id,source_lifecycle_status FROM tender.tenders WHERE external_id=ANY($1::text[]) ORDER BY external_id", [["sync-expired", "sync-withdrawn"]])).rows;
  assert.deepEqual(states, [{ external_id: "sync-expired", source_lifecycle_status: "EXPIRED" }, { external_id: "sync-withdrawn", source_lifecycle_status: "WITHDRAWN" }]);

  const partial = await importFetchedDay(pool, fetched("2026-08-20", [release({ id: "sync-valid-after-error" }), { id: "sync-invalid", tender: { title: "Incomplete" } }], "partial"));
  assert.equal(partial.passed, false);
  assert.equal(partial.counts.new, 1);
  assert.equal(partial.counts.quarantined, 1);
  assert.equal((await pool.query("SELECT status FROM tender.scheduler_runs WHERE id=$1", [partial.schedulerRunId])).rows[0].status, "PARTIAL_FAILURE");

  const unknown = await importFetchedDay(pool, fetched("2026-08-21", [release({ id: "sync-unknown", title: "Spezialisierte unbekannte Leistung", description: "Ohne eindeutiges Gewerk", cpv: "99999999" })], "unknown"));
  assert.equal(unknown.counts.new, 1);
  assert.equal((await pool.query("SELECT classification_status FROM tender.tenders WHERE external_id='sync-unknown'")).rows[0].classification_status, "REVIEW_REQUIRED");

  const ownerA = crypto.randomUUID(), ownerB = crypto.randomUUID();
  assert.equal(await acquireLease(pool, "TED", ownerA), true);
  assert.equal(await acquireLease(pool, "TED", ownerB), false);
  await pool.query("DELETE FROM tender.scheduler_leases WHERE source_code='TED' AND owner_id=$1", [ownerA]);

  const overview = (await pool.query("SELECT external_id,publication_date FROM tender.tenders WHERE data_class='PUBLIC_REAL' AND classification_status<>'PENDING' ORDER BY (source_lifecycle_status='ACTIVE') DESC,publication_date DESC NULLS LAST,updated_at DESC,id LIMIT 10")).rows;
  assert.ok(overview.some((row) => row.external_id === "sync-unknown"));
  console.log(JSON.stringify({ passed: true, firstImport: first.counts, repeatedImport: repeated.counts, changedImport: changed.counts, lifecycleImport: lifecycle.counts, partialImport: partial.counts, unknownClassification: "REVIEW_REQUIRED", parallelLeaseRejected: true, overviewVisible: true }));
} finally { await pool.end(); }
