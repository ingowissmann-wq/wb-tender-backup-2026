import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const runner = fs.readFileSync(new URL("../scripts/isolated-blka-grouped-approved-shadow.mjs", import.meta.url), "utf8");
const replay = fs.readFileSync(new URL("../scripts/isolated-blka-grouped-approved-shadow-replay.sh", import.meta.url), "utf8");

test("BLKA grouped shadow binds the exact approved business values and base term", () => {
  assert.match(runner, /A: 195, B: 160, C: 75, D: 310/);
  assert.match(runner, /contractMonths: 24/);
  assert.match(runner, /maximumContractMonths: 60/);
  assert.match(runner, /annualHours: 14011\.83/);
  assert.match(runner, /productiveHours: 28023\.66/);
  assert.match(runner, /NONPERSISTENT_CASE_APPROVED_GROUPED_SHADOW_INPUT/);
  assert.match(runner, /MANAGEMENT_REVIEW_REQUIRED_PARTIAL/);
  assert.match(runner, /externalWrite: false/);
  assert.match(runner, /createCalculationContractSnapshot/);
  assert.match(runner, /executeCalculationContractSnapshot/);
  assert.match(runner, /VERIFIED_PROCUREMENT_DOCUMENT_SET/);
  assert.match(runner, /createGroupedPerformanceDecision/);
  assert.match(runner, /classification: "CASE_APPROVED"/);
  assert.match(runner, /groupedPerformanceDecision/);
  assert.doesNotMatch(runner, /calculateSectorTender/);
});

test("BLKA grouped replay is clone-only, fingerprinted and submission inert", () => {
  assert.match(replay, /database=\$\{RESTORE_DATABASE:-wb_platform_restore\}/);
  assert.match(replay, /default_transaction_read_only=on/);
  assert.match(replay, /before=\$\(fingerprint\)/);
  assert.match(replay, /test "\$before" = "\$after"/);
  assert.match(replay, /c22_count/);
  assert.match(replay, /external transmission stayed disabled/);
});
