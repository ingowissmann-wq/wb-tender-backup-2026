import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const shell = fs.readFileSync(new URL("../scripts/isolated-blka-cleaning-shadow-replay.sh", import.meta.url), "utf8"),
  runner = fs.readFileSync(new URL("../scripts/isolated-blka-cleaning-shadow.mjs", import.meta.url), "utf8");

test("BLKA shadow replay is exact, clone-only, cross-lot isolated and read-only", () => {
  assert.match(shell, /EXPECTED_COMMIT/);
  assert.match(shell, /EXPECTED_TREE/);
  assert.match(shell, /wb-tender-restore-verify-/);
  assert.match(shell, /published/);
  assert.match(shell, /before_fingerprint/);
  assert.match(shell, /after_fingerprint/);
  assert.match(shell, /approved_C22_C23_rows/);
  assert.match(shell, /CALCULATION_BLOCKED_MISSING_INPUT_C22_C23/);
  assert.doesNotMatch(shell, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i);
  assert.doesNotMatch(shell, /docker\s+(?:rm|volume\s+rm|network\s+rm)/i);
  assert.match(runner, /selectLotAuthoritativeDocuments/);
  assert.match(runner, /LOT-0001/);
  assert.match(runner, /88596379-a007-4913-b26a-42cfe2b72309/);
  assert.match(runner, /ae5a386fd253bbe209b79066137bc399ce58bc0ba34e9c5478cfb37b89f16822/);
  assert.match(runner, /2589414\.889362/);
  assert.match(runner, /29142\.6877/);
  assert.match(runner, /externalWrite:\s*false/);
});
