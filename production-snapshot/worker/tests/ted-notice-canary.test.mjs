import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyTedNoticeArtifact } from "../platform/ted-notice-canary.mjs";

const fixture = `<!doctype html><html><body><h1>581484-2026</h1><section>LOT-0001</section><section>LOT-0002</section>${"x".repeat(600)}</body></html>`;

test("verifies an exact official TED tender and all canonical lots", () => {
  const result=verifyTedNoticeArtifact({content:fixture,contentType:"text/html; charset=utf-8",status:200,externalId:"581484-2026",lotKeys:["LOT-0001","LOT-0002"]});
  assert.equal(result.valid,true);
  assert.equal(result.lotCount,2);
  assert.match(result.sha256,/^[a-f0-9]{64}$/);
});

test("fails closed for wrong MIME, tender or missing lot", () => {
  const result=verifyTedNoticeArtifact({content:fixture,contentType:"application/octet-stream",status:200,externalId:"other",lotKeys:["LOT-0001","LOT-0003"]});
  assert.equal(result.valid,false);
  assert.deepEqual(result.errors,["MIME_TYPE_INVALID","TENDER_ID_MISSING","LOT_IDS_MISSING"]);
  assert.deepEqual(result.missingLots,["LOT-0003"]);
});

test("production canary is read-only and browser network is denied", () => {
  const source=readFileSync(new URL("../scripts/ted-public-tender-lot-canary.mjs",import.meta.url),"utf8");
  assert.match(source,/BEGIN READ ONLY/);
  assert.match(source,/method:"GET"/);
  assert.match(source,/page\.route\("\*\*\/\*"/);
  assert.match(source,/externalWrite:false,transmitted:false,passed:true/);
  assert.doesNotMatch(source,/method:\s*"(?:POST|PUT|PATCH|DELETE)"/);
});
