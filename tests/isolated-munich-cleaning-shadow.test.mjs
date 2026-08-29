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
  assert.match(runner, /createCalculationContractSnapshot/);
  assert.match(runner, /executeCalculationContractSnapshot/);
  assert.match(runner, /VERIFIED_PROCUREMENT_DOCUMENT_SET/);
  assert.doesNotMatch(runner, /calculateSectorTender/);
  assert.doesNotMatch(runner, /INSERT INTO|UPDATE tender\.|DELETE FROM/);
});

test("Munich shadow verifies workforce values and the exact approved hourly C11 price", () => {
  for (const marker of [
    "productiveHours: 2906.38",
    "annualHours: 726.59",
    "monthlyHours: 60.55",
    "fte: 0.44",
    'material: 1453.19',
    'totalPrice: 102572.2',
    'hourlyRate: 35.29',
    'annualPrice: 25643.05',
    '"CALCULATION_PARTIAL"',
    '"MANAGEMENT_OUTPUT_GENERATED"',
    '"MANAGEMENT_REVIEW_REQUIRED_PARTIAL"',
    '"C13,C14"',
    'workforceStatus: "WORKFORCE_VALUES_VERIFIED"',
    'exact(calculation.externalTransmission, false',
    'exact(management.externalTransmission, false',
  ]) assert.ok(runner.includes(marker), `missing gate: ${marker}`);
});

test("Munich replay requires exact approved C11 and migration 156", () => {
  assert.match(script, /0156-c11-hourly-material-contract/);
  assert.match(script, /approved exact-scope C11=0\.50 EUR_PER_HOUR/);
  assert.match(runner, /exact\(c11\.unit, "EUR_PER_HOUR"/);
  assert.match(runner, /C11 approval\/activation provenance is incomplete/);
});
