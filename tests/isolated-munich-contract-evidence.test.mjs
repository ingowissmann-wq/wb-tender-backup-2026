import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../scripts/isolated-munich-contract-evidence.sh", import.meta.url),
  "utf8",
);

test("Munich contract evidence audit is exact-scope, read-only and fingerprint gated", () => {
  for (const marker of [
    "2203e521-6be7-4760-a15e-1357f833b279",
    "15c3c602-aa51-4dd4-adc1-3586dc82e523",
    "f00be7ac-3de5-487b-b867-fe859e45c14a",
    "default_transaction_read_only=on",
    "BEGIN TRANSACTION READ ONLY",
    "before=$(fingerprint)",
    "after=$(fingerprint)",
    'test "$before" = "$after"',
  ]) assert.ok(source.includes(marker), `missing gate: ${marker}`);
  assert.doesNotMatch(source, /INSERT INTO|UPDATE tender\.|DELETE FROM|TRUNCATE|DROP TABLE/);
});

test("Munich contract evidence retains document, page and hash provenance", () => {
  assert.match(source, /document\.payload_sha256/);
  assert.match(source, /page_number/);
  assert.match(source, /Vertragsbeginn/);
  assert.match(source, /Vertragsende/);
  assert.match(source, /autopilot_results/);
});
