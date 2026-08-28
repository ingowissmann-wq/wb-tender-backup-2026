import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const up = readFileSync(
  new URL("../migrations/131_calculation_version_concurrency.sql", import.meta.url),
  "utf8",
);
const down = readFileSync(
  new URL("../migrations/131_calculation_version_concurrency.down.sql", import.meta.url),
  "utf8",
);
const overlay = new URL(
  "../deployment/context-portal-readiness-128-overlay/platform/autopilot-pipeline-worker.mjs",
  import.meta.url,
);
const shipped = new URL("../platform/autopilot-pipeline-worker.mjs", import.meta.url);
const worker = readFileSync(existsSync(fileURLToPath(overlay)) ? overlay : shipped, "utf8");

test("duplicate calculation repair preserves business rows and audits version-only changes", () => {
  assert.ok(up.includes("calculation_duplicate_version_repaired"));
  assert.ok(up.includes("'priceDataChanged',false"));
  assert.ok(up.includes("target.version old_version"));
  assert.ok(up.includes("SET version=renumbered.new_version"));
  assert.doesNotMatch(up, /DELETE\s+FROM\s+tender\.calculations/i);
});

test("database enforces exact context and version uniqueness", () => {
  assert.ok(up.includes("CREATE UNIQUE INDEX IF NOT EXISTS calculations_context_version_uq"));
  assert.ok(up.includes("tender_id,company_id,coalesce(lot_key,''),version"));
  assert.ok(down.includes("DROP INDEX IF EXISTS tender.calculations_context_version_uq"));
  assert.doesNotMatch(down, /UPDATE\s+tender\.calculations/i);
});

test("worker serializes version allocation and insert in one transaction", () => {
  const start = worker.indexOf("calculation-version:${tender.id}");
  const end = worker.indexOf("UPDATE tender.autopilot_results", start);
  const implementation = worker.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.ok(implementation.includes('calculationClient.query("BEGIN")'));
  assert.ok(implementation.includes("pg_advisory_xact_lock(hashtextextended($1,0))"));
  assert.ok(implementation.includes("coalesce(max(version),0)+1"));
  assert.ok(implementation.includes("INSERT INTO tender.calculations"));
  assert.ok(implementation.includes('calculationClient.query("COMMIT")'));
  assert.ok(implementation.includes('calculationClient.query("ROLLBACK")'));
});
