import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source=fs.readFileSync(new URL("../scripts/portal-registry-public-canary.mjs",import.meta.url),"utf8");

test("registry canary is dynamic, read-only and credential-free",()=>{
  assert.match(source,/FROM tender\.portal_registry ORDER BY canonical_domain/);
  assert.match(source,/method:"GET"/);
  assert.doesNotMatch(source,/method:\s*"(?:POST|PUT|PATCH|DELETE)"/);
  assert.match(source,/credentialUse:false/);
  assert.match(source,/cookieUse:false/);
  assert.match(source,/externalWrite:false/);
  assert.match(source,/transmitted:false/);
});

test("every redirect is constrained to the registry host set",()=>{
  assert.match(source,/next\.protocol!=="https:"\|\|!allowedHost\(next\.hostname,allowed\)/);
  assert.match(source,/REGISTRY_REDIRECT_HOST_REPAIR_REQUIRED/);
  assert.match(source,/redirect:"manual"/);
  assert.match(source,/REDIRECT_LIMIT_EXCEEDED/);
});
