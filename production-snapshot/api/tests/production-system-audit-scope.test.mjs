import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../scripts/production-system-audit.mjs", import.meta.url), "utf8");

test("production audit derives and installs the authoritative background RLS scope", () => {
  assert.match(source, /loadBackgroundScope\(rawPool\)/);
  assert.match(source, /createFixedScopedPool\(rawPool, backgroundScope\)\.pool\.connect\(\)/);
  assert.doesNotMatch(source, /new pg\.Client/);
});

test("production audit keeps its database transaction read-only and releases all resources", () => {
  assert.match(source, /BEGIN TRANSACTION READ ONLY/);
  assert.match(source, /await client\.query\("ROLLBACK"\)/);
  assert.match(source, /await client\.release\(\)/);
  assert.match(source, /await rawPool\.end\(\)/);
});
