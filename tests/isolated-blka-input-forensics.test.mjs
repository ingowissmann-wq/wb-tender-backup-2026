import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shell = await readFile(new URL("../scripts/isolated-blka-input-forensics.sh", import.meta.url), "utf8");
const runner = await readFile(new URL("../scripts/isolated-blka-input-forensics.mjs", import.meta.url), "utf8");

test("BLKA input forensics is exact-scope, clone-only and read-only", () => {
  assert.match(shell, /514707-2026/);
  assert.match(shell, /06e91129-00c0-4820-9fbe-087e3517ce80/);
  assert.match(shell, /50479867-5774-4db4-bdef-b93a7d0eb88f/);
  assert.match(shell, /5e885f85-c63e-47c8-ac5e-ab6770f9d446/);
  assert.match(shell, /classification='CORE_REGION'/);
  assert.match(shell, /default_transaction_read_only=on/);
  assert.match(shell, /before_fingerprint/);
  assert.match(shell, /after_fingerprint/);
  assert.doesNotMatch(shell, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i);
});

test("BLKA forensics derives known area but never invents C22", () => {
  assert.match(runner, /2589414\.889362/);
  assert.match(runner, /29142\.6877/);
  assert.match(runner, /C22Persistence: "NONE"/);
  assert.match(runner, /calculationExecuted: false/);
  assert.match(runner, /CALCULATION_BLOCKED_MISSING_INPUT_C22/);
  assert.match(runner, /externalWrite: false/);
  assert.match(runner, /externalTransmission: false/);
  assert.doesNotMatch(runner, /C22:\s*225/);
});

test("BLKA forensics inventories performance, productive-hour and duration evidence", () => {
  assert.match(runner, /performanceCandidates/);
  assert.match(runner, /productiveHoursCandidates/);
  assert.match(runner, /durationCandidates/);
  assert.match(runner, /fieldCandidates/);
  assert.match(runner, /performanceScenario/);
  assert.match(runner, /C22_GROUP_SCENARIO_REQUIRES_BUSINESS_APPROVAL/);
  assert.match(runner, /SCENARIO_ONLY_NOT_APPROVED/);
  assert.match(runner, /sha256: document\.payload_sha256/);
});
