import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const script = await readFile(
  new URL("../scripts/isolated-munich-cleaning-shadow-replay.sh", import.meta.url),
  "utf8",
);
const runner = await readFile(
  new URL("../scripts/isolated-munich-cleaning-shadow.mjs", import.meta.url),
  "utf8",
);

test("Munich replay is isolated, read-only and fingerprint gated", () => {
  assert.match(script, /default_transaction_read_only=on/);
  assert.match(script, /BEGIN TRANSACTION READ ONLY/);
  assert.match(script, /before=\$\(fingerprint\)/);
  assert.match(script, /after=\$\(fingerprint\)/);
  assert.match(script, /test "\$before" = "\$after"/);
  assert.doesNotMatch(script, /INSERT INTO|UPDATE tender\.|DELETE FROM|TRUNCATE|DROP TABLE/);
});

test("Munich shadow keeps C22 nonpersistent and binds C23 to the approved scope", () => {
  assert.match(runner, /annualCleaningArea: 163483\.68/);
  assert.match(runner, /cleaningPerformance: 225/);
  assert.match(runner, /fteAnnualHours: 1670/);
  assert.match(runner, /NONPERSISTENT_CASE_APPROVED_SHADOW_INPUT/);
  assert.match(runner, /ACTIVE_APPROVED_EXACT_CONFIGURATION_SCOPE/);
  assert.match(runner, /C22Persistence: "NONE_CASE_SCOPED_SHADOW_ONLY"/);
  assert.doesNotMatch(runner, /INSERT INTO|UPDATE tender\.|DELETE FROM/);
});

test("Munich shadow asserts accepted values, schema 5 and internal management output", () => {
  for (const marker of [
    "productiveHours: 2906.38",
    "annualHours: 726.59",
    "monthlyHours: 60.55",
    "fte: 0.44",
    'exact(calculation.schemaVersion, 5',
    'exact(calculation.externalTransmission, false',
    'exact(management.externalTransmission, false',
  ]) assert.ok(runner.includes(marker), `missing gate: ${marker}`);
});
