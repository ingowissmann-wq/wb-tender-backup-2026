import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const worker = await readFile(
  new URL("../platform/autopilot-pipeline-worker.mjs", import.meta.url),
  "utf8",
);

test("Cleaning never falls back to generic free-text hours", () => {
  assert.match(
    worker,
    /item\.service_scope === "cleaning"\s*\? null\s*:\s*result\.review\.calculation\?\.neededHours/,
  );
  assert.match(worker, /generische Stundenangaben aus Freitext/);
});

test("Cleaning sends only authoritative derived area to the pricing engine", () => {
  assert.match(worker, /fact\.key === "areas"/);
  assert.match(
    worker,
    /item\.service_scope === "cleaning"\s*\? Number\.isFinite\(derivedCleaningArea\)/,
  );
});

test("Cleaning C22 requires active approved exact-scope configuration", () => {
  const c22 = worker.slice(
    worker.indexOf("cleaningPerformanceRow ="),
    worker.indexOf("cleaningPerformance ="),
  );
  for (const marker of [
    "configuration_versions",
    "configuration_scopes",
    "version.status='ACTIVE'",
    "version.approved_by IS NOT NULL",
    "version.approved_at IS NOT NULL",
    "change.unit='M2_PER_HOUR'",
  ]) assert.ok(c22.includes(marker), `missing C22 gate: ${marker}`);
});
